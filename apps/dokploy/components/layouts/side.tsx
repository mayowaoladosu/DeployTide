import type { ReactNode } from "react";
import { ProductNavigation } from "@/components/navigation/product-navigation";

export default function Page({ children }: { children: ReactNode }) {
	return <ProductNavigation>{children}</ProductNavigation>;
}
