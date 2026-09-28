import { generateIssuerKeys } from "./license-signing";

const USAGE = `Usage:
  bun run license:keygen`;

function keygen() {
	const { privateKey, publicKey } = generateIssuerKeys();
	console.log("Put this public key in ISSUER_PUBLIC_KEY in server/license-signing.ts and ship it with the release:\n");
	console.log(`${publicKey}\n`);
	console.log("Put this private key only in the .env of the server that sells licenses. Never commit or share it:\n");
	console.log(`RABBITPAY_LICENSE_SIGNING_KEY=${privateKey}`);
}

const [command] = process.argv.slice(2);

if (command === "keygen") keygen();
else {
	console.error(USAGE);
	process.exit(1);
}
