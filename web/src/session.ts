import { Api, clearSession, getToken, storeSession, type Account } from "./api";
import { navigate } from "./router";

export async function signOut() {
	try {
		await Api.logout();
	} catch {
		void 0;
	}
	clearSession();
	navigate("/login");
}

export async function refreshAccount(): Promise<Account | null> {
	const token = getToken();
	if (token === null) return null;
	try {
		const account = await Api.me();
		storeSession(token, account);
		return account;
	} catch {
		return null;
	}
}
