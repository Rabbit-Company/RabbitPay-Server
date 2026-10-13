export interface MailSink {
	port: number;
	messages: string[];
	stop: () => void;
}

export function startMailSink(port: number): MailSink {
	const messages: string[] = [];
	const server = Bun.listen<{ receiving: boolean; buffer: string }>({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.data = { receiving: false, buffer: "" };
				socket.write("220 help-shots mail sink\r\n");
			},
			data(socket, chunk) {
				socket.data.buffer += chunk.toString();
				if (socket.data.receiving) {
					const end = socket.data.buffer.indexOf("\r\n.\r\n");
					if (end === -1) return;
					messages.push(socket.data.buffer.slice(0, end));
					socket.data.buffer = socket.data.buffer.slice(end + 5);
					socket.data.receiving = false;
					socket.write("250 Stored\r\n");
				}
				for (;;) {
					const line = socket.data.buffer.indexOf("\r\n");
					if (line === -1 || socket.data.receiving) return;
					const command = socket.data.buffer.slice(0, line).toUpperCase();
					socket.data.buffer = socket.data.buffer.slice(line + 2);
					if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-help-shots\r\n250 SIZE 52428800\r\n");
					else if (command.startsWith("DATA")) {
						socket.data.receiving = true;
						socket.write("354 Send the message\r\n");
					} else if (command.startsWith("QUIT")) {
						socket.write("221 Bye\r\n");
						socket.end();
					} else socket.write("250 OK\r\n");
				}
			},
		},
	});
	return { port, messages, stop: () => server.stop(true) };
}
