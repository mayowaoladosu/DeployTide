import type { GetServerSidePropsContext } from "next";
import type { InfrastructureSection } from "@/components/admin/infrastructure-console";
import { InfrastructureConsole } from "@/components/admin/infrastructure-console";
import type { OperatorPageProps } from "@/server/operator-pages";
import { requireSuperadminPage } from "@/server/operator-pages";

const sections = new Set<InfrastructureSection>([
	"providers",
	"regions",
	"build-pools",
	"runtime-clusters",
	"capacity",
	"versions",
	"drains",
	"incidents",
	"certificates",
	"migration",
]);

interface Props extends OperatorPageProps {
	section: InfrastructureSection;
}

export default function InfrastructureSectionPage(props: Props) {
	return <InfrastructureConsole {...props} />;
}

InfrastructureSectionPage.getLayout = (page: React.ReactElement) => page;

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const section = Array.isArray(ctx.params?.section)
		? ctx.params?.section[0]
		: ctx.params?.section;
	if (!section || !sections.has(section as InfrastructureSection)) {
		return { notFound: true };
	}
	const auth = await requireSuperadminPage(ctx);
	if (!("props" in auth)) return auth;
	return { props: { ...auth.props, section } };
}
