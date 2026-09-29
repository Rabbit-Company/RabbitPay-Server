import { companyFor, displayNameOf } from "../company";
import { loadLogo } from "../branding";
import RenderPool from "../render-pool";
import type { PayrollCalculation } from "./payroll-runs";
import type { PayrollRunRow, ProjectRow } from "../database/models";

export async function payslipsPdf(project: ProjectRow, run: PayrollRunRow, lines: PayrollCalculation[]): Promise<Uint8Array> {
	const details = await companyFor(project.uuid);
	const company = { name: details.legal_name || displayNameOf(project), details, logo: await loadLogo(project.uuid) };
	return await RenderPool.render({ kind: "payslips", input: { project, run, lines, company } });
}
