import { QRCode, toSVG } from "@rabbit-company/qrcode";
import { latin2 } from "@rabbit-company/qrcode/payload";
import { el } from "./dom";
import { t } from "../../server/i18n";
import { t as ui } from "./i18n";
import { UPN_QR_OPTIONS } from "../../server/upn-qr";

export interface QrPayload {
	format: string;
	payload: string;
	encoding: "utf8" | "latin2";
}

export function qrSvg(payload: QrPayload, scale = 5): string {
	if (payload.format === "upn") return QRCode.encodeBinary(latin2(payload.payload), UPN_QR_OPTIONS).toSVG({ scale, margin: 2 });
	if (payload.encoding === "latin2") return QRCode.encodeBinary(latin2(payload.payload)).toSVG({ scale, margin: 2 });
	return toSVG(payload.payload, { scale, margin: 2 });
}

export function qrBlock(payload: QrPayload, caption?: string, scale = 5): HTMLElement {
	const wrapper = el("div", { class: "qr" });

	try {
		wrapper.innerHTML = qrSvg(payload, scale);
	} catch {
		return el("p", { class: "muted" }, ui("ui.qr_failed"));
	}

	if (!caption) return wrapper;

	return el("div", { class: "qr-with-caption" }, wrapper, el("p", { class: "muted" }, caption));
}

export function qrCaption(format: string, language?: string): string {
	if (format === "upn") return t(language, "qr.upn_long");
	if (format === "epc") return t(language, "qr.epc_long");
	return t(language, "qr.generic_long");
}

export function shortQrCaption(format: string, language?: string): string {
	if (format === "upn") return t(language, "qr.upn");
	if (format === "epc") return t(language, "qr.epc");
	return t(language, "qr.generic");
}
