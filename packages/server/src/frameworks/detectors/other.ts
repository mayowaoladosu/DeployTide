import { hasFile, manifestText } from "../evidence";
import type { FrameworkDetectionResult, FrameworkDetector } from "../types";

export const dockerfileDetector: FrameworkDetector = {
	id: "dockerfile",
	detect(evidence): FrameworkDetectionResult | null {
		if (!hasFile(evidence, "Dockerfile")) return null;
		return {
			preset: "dockerfile",
			label: "Dockerfile",
			// Explicit Dockerfiles always win over inferred presets.
			confidence: 1,
			buildType: "dockerfile",
			packageManager: "unknown",
			evidence: [{ message: "Detected via root Dockerfile" }],
			warnings: [],
		};
	},
};

const pythonWebFrameworks: Array<{
	id: string;
	label: string;
	pattern: RegExp;
	startCommand: string;
	port: number;
}> = [
	{
		id: "fastapi",
		label: "FastAPI",
		pattern: /\bfastapi\b/i,
		startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
		port: 8000,
	},
	{
		id: "django",
		label: "Django",
		pattern: /\bdjango\b/i,
		startCommand: "gunicorn wsgi:application --bind 0.0.0.0:8000",
		port: 8000,
	},
	{
		id: "flask",
		label: "Flask",
		pattern: /\bflask\b/i,
		startCommand: "gunicorn app:app --bind 0.0.0.0:8000",
		port: 8000,
	},
];

export const pythonDetector: FrameworkDetector = {
	id: "python",
	detect(evidence): FrameworkDetectionResult | null {
		const requirements = manifestText(evidence, "requirements.txt");
		const pyproject = manifestText(evidence, "pyproject.toml");
		const pipfile = manifestText(evidence, "Pipfile");
		if (!requirements && !pyproject && !pipfile && !hasFile(evidence, "manage.py")) {
			return null;
		}
		const combinedManifest = `${requirements ?? ""}\n${pyproject ?? ""}`;
		const framework = pythonWebFrameworks.find((candidate) =>
			candidate.pattern.test(combinedManifest),
		);
		const packageManager = hasFile(evidence, "uv.lock")
			? "uv"
			: pipfile
				? "pipenv"
				: pyproject?.includes("[tool.poetry]")
					? "poetry"
					: "pip";
		const installCommand =
			packageManager === "uv"
				? "uv sync"
				: packageManager === "pipenv"
					? "pipenv install --deploy"
					: packageManager === "poetry"
						? "poetry install"
						: "pip install -r requirements.txt";
		if (framework) {
			return {
				preset: framework.id,
				label: framework.label,
				confidence: 0.9,
				buildType: "railpack",
				packageManager,
				installCommand,
				startCommand: framework.startCommand,
				port: framework.port,
				evidence: [
					{ message: `Detected via ${framework.label} dependency evidence` },
				],
				warnings: [],
			};
		}
		if (hasFile(evidence, "manage.py")) {
			return {
				preset: "django",
				label: "Django",
				confidence: 0.75,
				buildType: "railpack",
				packageManager,
				installCommand,
				startCommand: "gunicorn wsgi:application --bind 0.0.0.0:8000",
				port: 8000,
				evidence: [{ message: "Detected via manage.py" }],
				warnings: [],
			};
		}
		return {
			preset: "python",
			label: "Python",
			confidence: 0.4,
			buildType: "railpack",
			packageManager,
			installCommand,
			evidence: [{ message: "Detected via Python dependency manifest" }],
			warnings: ["Could not determine a specific web framework or start command."],
		};
	},
};

export const goDetector: FrameworkDetector = {
	id: "go",
	detect(evidence): FrameworkDetectionResult | null {
		if (!hasFile(evidence, "go.mod")) return null;
		return {
			preset: "go",
			label: "Go",
			confidence: 0.85,
			buildType: "railpack",
			packageManager: "go",
			installCommand: "go mod download",
			buildCommand: "go build -o app .",
			startCommand: "./app",
			port: 8080,
			evidence: [{ message: "Detected via go.mod" }],
			warnings: [],
		};
	},
};

export const rubyDetector: FrameworkDetector = {
	id: "ruby",
	detect(evidence): FrameworkDetectionResult | null {
		if (!hasFile(evidence, "Gemfile")) return null;
		const isRails = hasFile(evidence, "config/application.rb");
		return {
			preset: isRails ? "rails" : "ruby",
			label: isRails ? "Ruby on Rails" : "Ruby",
			confidence: isRails ? 0.9 : 0.6,
			buildType: "railpack",
			packageManager: "bundler",
			installCommand: "bundle install --deployment",
			startCommand: isRails
				? "bundle exec puma -C config/puma.rb"
				: "bundle exec ruby app.rb",
			port: 3000,
			evidence: [
				{
					message: isRails
						? "Detected via Gemfile + config/application.rb"
						: "Detected via Gemfile",
				},
			],
			warnings: [],
		};
	},
};

export const phpDetector: FrameworkDetector = {
	id: "php",
	detect(evidence): FrameworkDetectionResult | null {
		if (!hasFile(evidence, "composer.json")) return null;
		const composer = manifestText(evidence, "composer.json") ?? "";
		const isLaravel = /laravel\/framework/i.test(composer);
		return {
			preset: isLaravel ? "laravel" : "php",
			label: isLaravel ? "Laravel" : "PHP",
			confidence: isLaravel ? 0.9 : 0.6,
			buildType: "railpack",
			packageManager: "composer",
			installCommand: "composer install --no-dev --optimize-autoloader",
			startCommand: isLaravel
				? "php artisan serve --host 0.0.0.0 --port 8000"
				: "php -S 0.0.0.0:8000",
			port: 8000,
			evidence: [
				{
					message: isLaravel
						? "Detected via composer.json (laravel/framework)"
						: "Detected via composer.json",
				},
			],
			warnings: [],
		};
	},
};

export const javaDetector: FrameworkDetector = {
	id: "java",
	detect(evidence): FrameworkDetectionResult | null {
		const hasMaven = hasFile(evidence, "pom.xml");
		const hasGradle =
			hasFile(evidence, "build.gradle") || hasFile(evidence, "build.gradle.kts");
		if (!hasMaven && !hasGradle) return null;
		return {
			preset: "java",
			label: "Java",
			confidence: 0.7,
			buildType: "railpack",
			packageManager: hasMaven ? "maven" : "gradle",
			installCommand: hasMaven ? "mvn -B dependency:go-offline" : "./gradlew dependencies",
			buildCommand: hasMaven ? "mvn -B package -DskipTests" : "./gradlew build -x test",
			port: 8080,
			evidence: [
				{ message: hasMaven ? "Detected via pom.xml" : "Detected via build.gradle" },
			],
			warnings: ["Start command depends on the produced jar name; verify before deploying."],
		};
	},
};

export const dotnetDetector: FrameworkDetector = {
	id: "dotnet",
	detect(evidence): FrameworkDetectionResult | null {
		const hasProject = [...evidence.files].some(
			(file) => file.endsWith(".csproj") || file.endsWith(".sln"),
		);
		if (!hasProject) return null;
		return {
			preset: "dotnet",
			label: ".NET",
			confidence: 0.7,
			buildType: "railpack",
			packageManager: "dotnet",
			installCommand: "dotnet restore",
			buildCommand: "dotnet publish -c Release -o out",
			startCommand: "dotnet out/app.dll",
			port: 8080,
			evidence: [{ message: "Detected via .csproj/.sln file" }],
			warnings: ["Start command assumes the published DLL is named app.dll; verify before deploying."],
		};
	},
};
