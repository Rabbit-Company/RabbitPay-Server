import { describe, expect, test } from "bun:test";
import { certificateInfo, credentialsFromPkcs12 } from "../server/furs/credentials";
import { echo, fursEndpoint, registerPremise, submitInvoice } from "../server/furs/client";
import { fursTime, protectedId, verificationCode } from "../server/furs/zoi";

const certificatePath = Bun.env.FURS_TEST_P12;
const certificatePassword = Bun.env.FURS_TEST_PASSWORD;
const configured = Boolean(certificatePath && certificatePassword !== undefined);

const load = async () => {
	const credentials = credentialsFromPkcs12(new Uint8Array(await Bun.file(certificatePath!).arrayBuffer()), certificatePassword!);
	const info = certificateInfo(credentials.certificate);
	if (!info.test) throw new Error("FURS_TEST_P12 must be a certificate for the FURS test environment");
	return { credentials, taxNumber: info.taxNumber! };
};

const PREMISE = "RABBITPAY1";
const DEVICE = "TEST1";

describe.skipIf(!configured)("the FURS test environment", () => {
	test("answers the echo message over mutual TLS", async () => {
		const { credentials } = await load();
		await echo(fursEndpoint("test"), credentials);
	});

	test("registers a business premise", async () => {
		const { credentials, taxNumber } = await load();
		const header = await registerPremise(fursEndpoint("test"), credentials, {
			TaxNumber: taxNumber,
			BusinessPremiseID: PREMISE,
			BPIdentifier: { PremiseType: "C" },
			ValidityDate: fursTime(Date.now()).iso.slice(0, 10),
			SoftwareSupplier: [{ NameForeign: "RabbitPay" }],
			SpecialNotes: "RabbitPay integration test",
		});
		expect(header.MessageID).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("verifies an invoice and returns its EOR", async () => {
		const { credentials, taxNumber } = await load();
		const issuedAt = Date.now();
		const number = String(Math.floor(issuedAt / 1000));
		const zoi = protectedId(credentials.privateKey, { taxNumber, issuedAt, invoiceNumber: number, premise: PREMISE, device: DEVICE, amount: 1220 });

		const receipt = await submitInvoice(fursEndpoint("test"), credentials, {
			TaxNumber: taxNumber,
			IssueDateTime: fursTime(issuedAt).iso,
			NumberingStructure: "B",
			InvoiceIdentifier: { BusinessPremiseID: PREMISE, ElectronicDeviceID: DEVICE, InvoiceNumber: number },
			InvoiceAmount: 12.2,
			PaymentAmount: 12.2,
			TaxesPerSeller: [{ VAT: [{ TaxRate: 22, TaxableAmount: 10, TaxAmount: 2.2 }] }],
			ProtectedID: zoi,
		});

		expect(receipt.eor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(verificationCode(zoi, taxNumber, issuedAt)).toHaveLength(60);
	});
});
