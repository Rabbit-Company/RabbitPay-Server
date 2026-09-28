import { ErrorCorrectionLevel, type QRCodeOptions } from "@rabbit-company/qrcode";

export const FURS_QR_OPTIONS: QRCodeOptions = {
	minVersion: 2,
	maxVersion: 2,
	errorCorrectionLevel: ErrorCorrectionLevel.MEDIUM,
	boostEcc: false,
};
