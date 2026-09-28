import { ECI, ErrorCorrectionLevel, type QRCodeOptions } from "@rabbit-company/qrcode";

export const UPN_QR_OPTIONS: QRCodeOptions = {
	minVersion: 15,
	maxVersion: 15,
	errorCorrectionLevel: ErrorCorrectionLevel.MEDIUM,
	boostEcc: false,
	eci: ECI.ISO_8859_2,
};
