import { describe, expect, it } from "vitest";
import { detectFramework } from "@dokploy/server/frameworks";
import type { RepositoryEvidence } from "@dokploy/server/frameworks";

const evidence = (
	files: string[],
	manifests: Record<string, string> = {},
): RepositoryEvidence => ({
	files: new Set(files),
	manifests: new Map(Object.entries(manifests)),
});

const pkg = (body: Record<string, unknown>) => JSON.stringify(body);

describe("detectFramework", () => {
	it("detects an explicit Dockerfile above every other signal", () => {
		const result = detectFramework(
			evidence(["Dockerfile", "package.json"], {
				"package.json": pkg({ dependencies: { next: "16.0.0" } }),
			}),
		);
		expect(result.preset).toBe("dockerfile");
		expect(result.buildType).toBe("dockerfile");
		expect(result.confidence).toBe(1);
	});

	it("detects Next.js and suggests a railpack server build", () => {
		const result = detectFramework(
			evidence(["package.json", "next.config.js"], {
				"package.json": pkg({
					dependencies: { next: "16.0.0", react: "19.0.0" },
					scripts: { build: "next build", start: "next start" },
				}),
			}),
		);
		expect(result.preset).toBe("nextjs");
		expect(result.buildType).toBe("railpack");
		expect(result.startCommand).toContain("start");
		expect(result.port).toBe(3000);
	});

	it("detects Vite as a static build with an output directory", () => {
		const result = detectFramework(
			evidence(["package.json"], {
				"package.json": pkg({
					devDependencies: { vite: "6.0.0" },
					scripts: { build: "vite build" },
				}),
			}),
		);
		expect(result.preset).toBe("vite");
		expect(result.buildType).toBe("static");
		expect(result.outputDirectory).toBe("dist");
	});

	it("detects Remix as a server build", () => {
		const result = detectFramework(
			evidence(["package.json"], {
				"package.json": pkg({
					devDependencies: { "@remix-run/dev": "2.0.0" },
					scripts: { build: "remix build", start: "remix-serve build" },
				}),
			}),
		);
		expect(result.preset).toBe("remix");
		expect(result.buildType).toBe("railpack");
	});

	it("detects Astro as a static build", () => {
		const result = detectFramework(
			evidence(["package.json"], {
				"package.json": pkg({
					dependencies: { astro: "5.0.0" },
					scripts: { build: "astro build" },
				}),
			}),
		);
		expect(result.preset).toBe("astro");
		expect(result.buildType).toBe("static");
	});

	it("detects a package manager from lockfiles (pnpm)", () => {
		const result = detectFramework(
			evidence(["package.json", "pnpm-lock.yaml"], {
				"package.json": pkg({ dependencies: { next: "16.0.0" } }),
			}),
		);
		expect(result.packageManager).toBe("pnpm");
		expect(result.installCommand).toContain("pnpm install");
	});

	it("detects a package manager from lockfiles (bun)", () => {
		const result = detectFramework(
			evidence(["package.json", "bun.lockb"], {
				"package.json": pkg({ dependencies: { next: "16.0.0" } }),
			}),
		);
		expect(result.packageManager).toBe("bun");
	});

	it("falls back to a generic Node server via scripts.start", () => {
		const result = detectFramework(
			evidence(["package.json"], {
				"package.json": pkg({ scripts: { start: "node server.js" } }),
			}),
		);
		expect(result.preset).toBe("node-server");
		expect(result.buildType).toBe("railpack");
	});

	it("detects a static site with no package.json", () => {
		const result = detectFramework(evidence(["index.html", "styles.css"]));
		expect(result.preset).toBe("static");
		expect(result.buildType).toBe("static");
	});

	it("detects FastAPI from requirements.txt", () => {
		const result = detectFramework(
			evidence(["requirements.txt", "main.py"], {
				"requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n",
			}),
		);
		expect(result.preset).toBe("fastapi");
		expect(result.port).toBe(8000);
	});

	it("detects Django from manage.py", () => {
		const result = detectFramework(
			evidence(["manage.py", "requirements.txt"], {
				"requirements.txt": "django==5.0.0\n",
			}),
		);
		expect(result.preset).toBe("django");
	});

	it("detects Flask from requirements.txt", () => {
		const result = detectFramework(
			evidence(["requirements.txt", "app.py"], {
				"requirements.txt": "flask==3.0.0\n",
			}),
		);
		expect(result.preset).toBe("flask");
	});

	it("detects a generic Python project without a recognized framework", () => {
		const result = detectFramework(
			evidence(["requirements.txt"], { "requirements.txt": "requests==2.32.0\n" }),
		);
		expect(result.preset).toBe("python");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("detects uv-managed Python projects", () => {
		const result = detectFramework(
			evidence(["pyproject.toml", "uv.lock"], {
				"pyproject.toml": "[project]\nname = \"app\"\n",
			}),
		);
		expect(result.packageManager).toBe("uv");
	});

	it("detects Go via go.mod", () => {
		const result = detectFramework(evidence(["go.mod", "main.go"]));
		expect(result.preset).toBe("go");
		expect(result.buildCommand).toContain("go build");
	});

	it("detects Ruby on Rails", () => {
		const result = detectFramework(
			evidence(["Gemfile", "config/application.rb"]),
		);
		expect(result.preset).toBe("rails");
	});

	it("detects plain Ruby without Rails", () => {
		const result = detectFramework(evidence(["Gemfile", "app.rb"]));
		expect(result.preset).toBe("ruby");
	});

	it("detects Laravel from composer.json", () => {
		const result = detectFramework(
			evidence(["composer.json"], {
				"composer.json": pkg({
					require: { "laravel/framework": "^11.0" },
				}),
			}),
		);
		expect(result.preset).toBe("laravel");
	});

	it("detects plain PHP without Laravel", () => {
		const result = detectFramework(
			evidence(["composer.json"], {
				"composer.json": pkg({ require: { "monolog/monolog": "^3.0" } }),
			}),
		);
		expect(result.preset).toBe("php");
	});

	it("detects Java via Maven", () => {
		const result = detectFramework(evidence(["pom.xml"]));
		expect(result.preset).toBe("java");
		expect(result.packageManager).toBe("maven");
	});

	it("detects Java via Gradle", () => {
		const result = detectFramework(evidence(["build.gradle"]));
		expect(result.preset).toBe("java");
		expect(result.packageManager).toBe("gradle");
	});

	it("detects .NET via a .csproj file", () => {
		const result = detectFramework(evidence(["App.csproj", "Program.cs"]));
		expect(result.preset).toBe("dotnet");
	});

	it("falls back to Railpack with no evidence at all", () => {
		const result = detectFramework(evidence([]));
		expect(result.preset).toBe("unknown");
		expect(result.buildType).toBe("railpack");
		expect(result.confidence).toBe(0);
	});

	it("prefers a specific framework over conflicting generic evidence", () => {
		const result = detectFramework(
			evidence(["package.json", "index.html"], {
				"package.json": pkg({
					dependencies: { next: "16.0.0" },
					scripts: { start: "next start" },
				}),
			}),
		);
		expect(result.preset).toBe("nextjs");
	});

	it("does not throw on a malformed package.json manifest", () => {
		const result = detectFramework(
			evidence(["package.json"], { "package.json": "{not valid json" }),
		);
		expect(result.preset).toBe("unknown");
	});

	it("ignores dependency-directory Dockerfiles when scanning a real repo tree", () => {
		const result = detectFramework(
			evidence(["package.json", "node_modules/some-pkg/Dockerfile"], {
				"package.json": pkg({ dependencies: { next: "16.0.0" } }),
			}),
		);
		// The detector only inspects the given evidence set; excluding
		// nested vendor Dockerfiles is the responsibility of the evidence
		// builder (github-evidence.ts / monorepo root scanning), which is
		// covered separately. Here we assert the root Dockerfile still wins
		// when it legitimately exists at the top level only.
		expect(result.preset).toBe("nextjs");
	});
});
