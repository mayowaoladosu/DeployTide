import type { ProviderContractMap, ProviderKind } from "./contracts";

const adapterKey = (kind: ProviderKind, adapterType: string) =>
	`${kind}:${adapterType}`;

export class InfrastructureAdapterRegistry {
	readonly #adapters = new Map<string, ProviderContractMap[ProviderKind]>();

	register<K extends ProviderKind>(
		kind: K,
		adapter: ProviderContractMap[K],
	): this {
		const key = adapterKey(kind, adapter.adapterType);
		if (this.#adapters.has(key)) {
			throw new Error(`Infrastructure adapter already registered: ${key}`);
		}
		this.#adapters.set(key, adapter);
		return this;
	}

	replace<K extends ProviderKind>(
		kind: K,
		adapter: ProviderContractMap[K],
	): this {
		this.#adapters.set(adapterKey(kind, adapter.adapterType), adapter);
		return this;
	}

	resolve<K extends ProviderKind>(
		kind: K,
		adapterType: string,
	): ProviderContractMap[K] {
		const key = adapterKey(kind, adapterType);
		const adapter = this.#adapters.get(key);
		if (!adapter) {
			throw new Error(`Infrastructure adapter is not registered: ${key}`);
		}
		return adapter as ProviderContractMap[K];
	}

	list(): Array<{ kind: ProviderKind; adapterType: string }> {
		return [...this.#adapters.keys()]
			.map((key) => {
				const separator = key.indexOf(":");
				return {
					kind: key.slice(0, separator) as ProviderKind,
					adapterType: key.slice(separator + 1),
				};
			})
			.sort((left, right) =>
				`${left.kind}:${left.adapterType}`.localeCompare(
					`${right.kind}:${right.adapterType}`,
				),
			);
	}
}
