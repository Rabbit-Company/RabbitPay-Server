import { companyFor, displayNameOf } from "../company";
import RenderPool from "../render-pool";
import type { MonthReport } from "./reports";
import type { EmployeeRow, ProjectRow } from "../database/models";

export async function monthReportPdf(project: ProjectRow, report: MonthReport, employees: EmployeeRow[]): Promise<Uint8Array> {
	const details = await companyFor(project.uuid);
	const company = { name: details.legal_name || displayNameOf(project), details };
	return await RenderPool.render({ kind: "month_report", input: { project, report, employees, company } });
}
