import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import {
	findServerById,
	findWorkspaceDeployment,
	IS_CLOUD,
	validateRequest,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { encodeBase64 } from "@dokploy/server/utils/docker/utils";
import { readValidDirectory } from "@dokploy/server/wss/utils";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";

const hasOperatorToken = (req: http.IncomingMessage) => {
	const expected = process.env.DEPLOYTIDE_OPERATOR_API_TOKEN;
	const raw = req.headers["x-deploytide-operator-token"];
	const provided = Array.isArray(raw) ? raw[0] : raw;
	if (!expected || !provided) return false;
	return timingSafeEqual(
		createHash("sha256").update(expected).digest(),
		createHash("sha256").update(provided).digest(),
	);
};

export const setupDeploymentLogsWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/listen-deployment",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/listen-deployment") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const deploymentId = url.searchParams.get("deploymentId");
		const legacyLogPath = url.searchParams.get("logPath");
		const legacyServerId = url.searchParams.get("serverId");
		const { user, session } = await validateRequest(req);

		// Generate unique connection ID for tracking
		const connectionId = `deployment-logs-${Date.now()}-${Math.random().toString(36).substring(7)}`;
		if (!deploymentId && (!legacyLogPath || !hasOperatorToken(req))) {
			console.log(`[${connectionId}] deploymentId not provided`);
			ws.close(4000, "deploymentId not provided");
			return;
		}

		if (!user || !session?.activeOrganizationId) {
			ws.close();
			return;
		}
		let logPath = legacyLogPath || "";
		let serverId: string | null = legacyServerId;
		if (deploymentId) {
			try {
				const deployment = await findWorkspaceDeployment(
					session.activeOrganizationId,
					deploymentId,
				);
				const serviceId =
					deployment.applicationId ??
					deployment.composeId ??
					deployment.previewDeployment?.applicationId;
				if (serviceId) {
					await checkServicePermissionAndAccess(
						{
							user: { id: user.id },
							session: {
								activeOrganizationId: session.activeOrganizationId,
							},
						},
						serviceId,
						{ deployment: ["read"] },
					);
				} else if (!hasOperatorToken(req)) {
					ws.close(4003, "Infrastructure logs are operator-only");
					return;
				}
				logPath = deployment.logPath;
				serverId = deployment.serverId ?? deployment.buildServerId;
			} catch {
				ws.close();
				return;
			}
		}
		if (!readValidDirectory(logPath, serverId)) {
			ws.close(4000, "Invalid deployment log path");
			return;
		}

		let tailProcess: ReturnType<typeof spawn> | null = null;
		let sshClient: Client | null = null;

		try {
			if (serverId) {
				const server = await findServerById(serverId);

				if (server.organizationId !== session.activeOrganizationId) {
					ws.close();
					return;
				}

				if (!server.sshKeyId) {
					ws.close();
					return;
				}

				sshClient = new Client();
				sshClient
					.on("ready", () => {
						const encodedPath = encodeBase64(logPath);
						const command = `tail -n +1 -f "$(echo '${encodedPath}' | base64 -d)"`;

						sshClient!.exec(command, (err, stream) => {
							if (err) {
								sshClient!.end();
								ws.close();
								return;
							}
							stream
								.on("close", () => {
									sshClient!.end();
									ws.close();
								})
								.on("data", (data: string) => {
									if (ws.readyState === ws.OPEN) {
										ws.send(data.toString());
									}
								})
								.stderr.on("data", (data) => {
									if (ws.readyState === ws.OPEN) {
										ws.send(data.toString());
									}
								});
						});
					})
					.on("error", (err) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(`SSH error: ${err.message}`);
							ws.close();
						}
						if (sshClient) {
							sshClient.end();
						}
					})
					.connect({
						host: server.ipAddress,
						port: server.port,
						username: server.username,
						privateKey: server.sshKey?.privateKey,
					});

				ws.on("close", () => {
					if (sshClient) {
						sshClient.end();
					}
				});
			} else {
				if (IS_CLOUD) {
					ws.send("This feature is not available in the cloud version.");
					ws.close();
					return;
				}
				tailProcess = spawn("tail", ["-n", "+1", "-f", logPath]);

				const stdout = tailProcess.stdout;
				const stderr = tailProcess.stderr;

				if (stdout) {
					stdout.on("data", (data) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(data.toString());
						}
					});
				}

				if (stderr) {
					stderr.on("data", (data) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(new Error(`tail error: ${data.toString()}`).message);
						}
					});
				}

				tailProcess.on("close", () => {
					ws.close();
				});

				tailProcess.on("error", () => {
					if (ws.readyState === ws.OPEN) {
						ws.close();
					}
				});

				ws.on("close", () => {
					if (tailProcess && !tailProcess.killed) {
						tailProcess.kill("SIGTERM");
						// Force kill after a timeout if it doesn't terminate
						setTimeout(() => {
							if (tailProcess && !tailProcess.killed) {
								tailProcess.kill("SIGKILL");
							} else {
							}
						}, 1000);
					} else {
					}
				});
			}
		} catch (error) {
			// Clean up resources on error
			if (tailProcess && !tailProcess.killed) {
				tailProcess.kill("SIGTERM");
				setTimeout(() => {
					if (tailProcess && !tailProcess.killed) {
						tailProcess.kill("SIGKILL");
					}
				}, 1000);
			}
			if (sshClient) {
				sshClient.end();
			}
			if (ws.readyState === ws.OPEN) {
				// @ts-ignore
				const errorMessage = error?.message as unknown as string;
				ws.send(errorMessage || "An error occurred");
				ws.close();
			}
		}
	});
};
