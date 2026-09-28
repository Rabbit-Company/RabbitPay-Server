(function () {
	"use strict";

	var origin = (function () {
		var current = document.currentScript;
		if (current && current.src) {
			var parsed = document.createElement("a");
			parsed.href = current.src;
			return parsed.protocol + "//" + parsed.host;
		}
		return window.location.origin;
	})();

	function payUrl(invoice) {
		return origin + "/pay/" + encodeURIComponent(invoice) + "?embed=1";
	}

	function styleOnce() {
		if (document.getElementById("rabbitpay-embed-style")) return;

		var style = document.createElement("style");
		style.id = "rabbitpay-embed-style";
		style.textContent = [
			".rabbitpay-overlay{position:fixed;inset:0;background:rgba(10,12,16,.6);display:flex;align-items:center;justify-content:center;padding:16px;z-index:2147483000}",
			".rabbitpay-frame{width:100%;max-width:460px;height:min(760px,92vh);border:0;border-radius:14px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.3)}",
			".rabbitpay-close{position:absolute;top:14px;right:18px;font:inherit;font-size:28px;line-height:1;background:none;border:0;color:#fff;cursor:pointer}",
			".rabbitpay-button{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.1rem;border-radius:8px;border:0;background:#4f46e5;color:#fff;font:inherit;font-weight:600;cursor:pointer}",
		].join("");
		document.head.appendChild(style);
	}

	function open(invoice, options) {
		if (!invoice) throw new Error("RabbitPay: an invoice id is required");
		styleOnce();

		var settings = options || {};
		var overlay = document.createElement("div");
		overlay.className = "rabbitpay-overlay";

		var frame = document.createElement("iframe");
		frame.className = "rabbitpay-frame";
		frame.src = payUrl(invoice);
		frame.setAttribute("title", "Payment");
		frame.setAttribute("allow", "clipboard-write");

		var close = document.createElement("button");
		close.className = "rabbitpay-close";
		close.setAttribute("aria-label", "Close");
		close.innerHTML = "&times;";

		function shut(reason) {
			if (!overlay.parentNode) return;
			overlay.parentNode.removeChild(overlay);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("message", onMessage);
			if (typeof settings.onClose === "function") settings.onClose(reason);
		}

		function onKey(event) {
			if (event.key === "Escape") shut("dismissed");
		}

		function onMessage(event) {
			if (event.origin !== origin || !event.data || event.data.source !== "rabbitpay") return;

			if (event.data.type === "paid") {
				if (typeof settings.onPaid === "function") settings.onPaid(event.data.invoice);
				if (settings.closeOnPaid !== false)
					setTimeout(function () {
						shut("paid");
					}, 1500);
			}
		}

		close.addEventListener("click", function () {
			shut("dismissed");
		});

		document.addEventListener("keydown", onKey);
		window.addEventListener("message", onMessage);

		overlay.appendChild(frame);
		overlay.appendChild(close);
		document.body.appendChild(overlay);

		return { close: shut };
	}

	function mount(element) {
		var invoice = element.getAttribute("data-rabbitpay-invoice");
		if (!invoice || element.getAttribute("data-rabbitpay-ready")) return;

		element.setAttribute("data-rabbitpay-ready", "1");

		var label = element.getAttribute("data-rabbitpay-label") || "Pay now";
		var button = document.createElement("button");
		button.type = "button";
		button.className = "rabbitpay-button";
		button.textContent = label;
		button.addEventListener("click", function () {
			open(invoice, {});
		});

		element.appendChild(button);
	}

	function scan() {
		var targets = document.querySelectorAll("[data-rabbitpay-invoice]");
		for (var index = 0; index < targets.length; index++) mount(targets[index]);
	}

	window.RabbitPay = { open: open, scan: scan, origin: origin };

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
	else scan();
})();
