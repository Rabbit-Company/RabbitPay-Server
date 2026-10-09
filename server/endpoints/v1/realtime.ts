import { Server } from "../../server";
import Auth from "../../auth";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Realtime, REALTIME_CLOSE_UNAUTHORIZED, REALTIME_PATH, REALTIME_TICKET_SECONDS } from "../../realtime";

const MAX_EVENT_BYTES = 64 * 1024;
const closed = new WeakSet<object>();

Server.app.post(`${REALTIME_PATH}/ticket`, Auth.required(), async (ctx) => {
	const ticket = await Realtime.issueTicket(Auth.account(ctx).username, ctx.get("sessionToken")!);
	if (ticket === null) return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	ctx.header("Cache-Control", "no-store");
	return Utils.ok(ctx, { ticket, expires_in: REALTIME_TICKET_SECONDS });
});

Server.app.get(REALTIME_PATH, (ctx) => Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT));

Server.app.websocket({
	idleTimeout: 120,
	maxPayloadLength: MAX_EVENT_BYTES,
	async open(socket) {
		const holder = socket.data.url === REALTIME_PATH ? await Realtime.redeemTicket(socket.data.query.get("ticket")) : null;
		if (holder === null) {
			socket.close(REALTIME_CLOSE_UNAUTHORIZED, "Unauthorized");
			return;
		}
		if (closed.has(socket)) return;
		Realtime.attach(socket, holder.username, holder.sessionToken);
		socket.send(JSON.stringify({ type: "ready" }));
	},
	async message(socket, message) {
		await Realtime.receive(socket, message);
	},
	close(socket) {
		closed.add(socket);
		Realtime.detach(socket);
	},
});
