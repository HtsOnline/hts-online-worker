/*
 * HTS Online Multiplayer relay for Cloudflare Workers + Durable Objects.
 * The room creator starts as logical owner; if they leave, ownership moves to
 * a randomly selected connected player. Durable Objects handle room discovery,
 * signaling, and fallback relay. Direct UDP can reduce game-packet traffic, but
 * it exposes public endpoint addresses to room members and may fail behind NATs.
 */

const ROOM_ID_RE = /^[A-F0-9]{32}$/;

async function readSkinBody(request, maxBytes) {
	const reader = request.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) {
				try { await reader.cancel(); } catch (_) { }
				throw Object.assign(new Error("Skin exceeds 7 MB"), { statusCode: 413 });
			}
			chunks.push(result.value);
		}
	} finally {
		try { reader.releaseLock(); } catch (_) { }
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return new Response("HTS relay online", { headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		if (url.pathname === "/api/rooms" && request.method === "GET") {
			const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
			return directory.fetch("https://directory/list");
		}
		const roomMatch = url.pathname.match(/^\/ws\/([A-F0-9]{32})$/i);
		if (roomMatch && request.headers.get("Upgrade") === "websocket") {
			const roomId = roomMatch[1].toUpperCase();
			const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
			const target = new URL(request.url);
			target.searchParams.set("room", roomId);
			return room.fetch(new Request(target.toString(), request));
		}
		const skinMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{32})\/skins(?:\/([A-F0-9]{32})\/([A-Za-z0-9_-]{1,48}))?$/i);
		if (skinMatch && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
			const roomId = skinMatch[1].toUpperCase();
			const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
			const target = new URL("https://room/skin");
			target.searchParams.set("room", roomId);
			if (skinMatch[2]) target.searchParams.set("player", skinMatch[2].toUpperCase());
			if (skinMatch[3]) target.searchParams.set("slot", skinMatch[3]);
			return room.fetch(new Request(target.toString(), request));
		}
		const inviteMatch = url.pathname.match(/^\/join\/([A-F0-9]{32})$/i);
		if (inviteMatch && request.method === "GET") {
			const roomId = inviteMatch[1].toUpperCase();
			const origin = url.origin;
			const page = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>" +
				"<title>Convite HTS</title><main style='font:16px system-ui;max-width:34em;margin:12vh auto;padding:1em'>" +
				"<h2>Sala do Heavy Truck Simulator</h2><p>Copie o código abaixo e cole na opção Multiplayer do jogo.</p>" +
				"<code id=c style='word-break:break-all'>" + roomId + "</code> " +
				"<button onclick=\"navigator.clipboard.writeText(document.querySelector('#c').textContent)\">Copiar código</button>" +
				"<p>Relay: " + origin + "</p></main>";
			return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		}
		return new Response("Not found", { status: 404 });
	}
};

export class Room {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/skin") return this.handleSkinRequest(request, url);
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
		const roomId = url.searchParams.get("room");
		if (!roomId || !ROOM_ID_RE.test(roomId)) return new Response("Invalid room code", { status: 400 });
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ roomId: roomId, id: "", nickname: "", owner: false, joined: false, lastMove: null, lastState: "", signalIp: request.headers.get("CF-Connecting-IP") || "", endpointIp: "", endpointPort: 0, p2pReady: false });
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, raw) {
		if (typeof raw !== "string" || raw.length > 20000) return this.fail(ws, "Pacote inválido.");
		const message = decodeWire(raw);
		if (!message || message.length < 1) return this.fail(ws, "Pacote inválido.");
		const peer = ws.deserializeAttachment() || {};
		if (!peer.joined) return this.join(ws, peer, message);
		if (message[0] === "P2P_READY") {
			peer.p2pReady = true;
			ws.serializeAttachment(peer);
			const room = await this.ctx.storage.get("room");
			if (!room) return;
			const peers = this.ctx.getWebSockets().map(function (socket) { return socket.deserializeAttachment() || {}; }).filter(function (state) { return state.joined; });
			if (peers.length > 1 && peers.every(function (state) { return state.p2pReady && state.endpointIp && state.endpointPort > 0; })) {
				room.directMode = true;
				await this.ctx.storage.put("room", room);
				this.broadcastJoined(encodeWire("DIRECT_MODE", ["1"]), null);
			}
			return;
		}
		if (message[0] === "P2P_FALLBACK") {
			return this.disableDirectMode(peer.roomId);
		}
		if (message[0] === "SKIN_LIST") {
			return this.sendSkinManifest(ws);
		}
		if (message[0] === "SKIN_DELETE" && message.length >= 2 && /^[A-Za-z0-9_-]{1,48}$/.test(message[1])) {
			const key = "skin:" + peer.id + ":" + message[1];
			const old = await this.ctx.storage.get(key);
			if (!old) return;
			await this.ctx.storage.delete(key);
			const room = await this.ctx.storage.get("room");
			if (room && Number.isFinite(old.size)) {
				room.skinBytes = Math.max(0, (Number(room.skinBytes) || 0) - old.size);
				await this.ctx.storage.put("room", room);
			}
			this.broadcastJoined(encodeWire("SKIN_REMOVED", [peer.id, message[1]]), null);
			return;
		}

		if (message[0] === "MOVE" && message.length >= 7 && message.length <= 32) {
			const room = await this.ctx.storage.get("room");
			if (room && room.directMode) return;
			const move = message.slice(1);
			if (move.some(function (value) { return value.length > 4096; })) return;
			peer.lastMove = move;
			if (move.length > 9 && move[9]) peer.lastState = move[9];
			ws.serializeAttachment(peer);
			const truck = [peer.id, peer.nickname].concat(move, [peer.owner ? "1" : "0"]);
			return this.broadcast(encodeWire("TRUCK", truck), ws);
		}
		if (message[0] === "CHAT" && message.length >= 2) {
			const room = await this.ctx.storage.get("room");
			if (room && room.directMode) return;
			const text = (message[1] || "").substring(0, 500);
			return this.broadcast(encodeWire("CHAT", [peer.nickname, text]), null);
		}
		if (message[0] === "VOICE" && message.length >= 2 && message[1].length <= 4096) {
			const room = await this.ctx.storage.get("room");
			if (room && room.directMode) return;
			return this.broadcast(encodeWire("VOICE", [message[1]]), ws);
		}
		if (message[0] === "TRAFFIC" && message.length >= 3 && message.length <= 4 && peer.owner) {
			const room = await this.ctx.storage.get("room");
			if (room && room.directMode) return;
			return this.broadcast(encodeWire("TRAFFIC", message.slice(1)), ws);
		}
		if (message[0] === "ENDPOINT" && message.length >= 3) {
			const port = parseInt(message[2], 10);
			const address = message[1];
			if (!isValidIPv4(address) || address !== peer.signalIp || !Number.isFinite(port) || port < 1 || port > 65535) return;
			peer.endpointIp = address;
			peer.endpointPort = port;
			peer.p2pReady = false;
			ws.serializeAttachment(peer);
			const room = await this.ctx.storage.get("room");
			if (room) {
				room.directMode = false;
				for (const other of this.ctx.getWebSockets()) {
					const state = other.deserializeAttachment() || {};
					if (state.joined) {
						state.p2pReady = false;
						other.serializeAttachment(state);
					}
				}
				await this.ctx.storage.put("room", room);
				this.broadcastJoined(encodeWire("DIRECT_MODE", ["0"]), null);
			}
			const endpoint = encodeWire("ENDPOINT", [peer.id, peer.nickname, address, port, peer.token]);
			this.broadcastJoined(endpoint, ws);
			this.sendPeerEndpoints(ws);
			return;
		}
		if ((message[0] === "KICK" || message[0] === "BAN") && message.length >= 2 && peer.owner) {
			return this.moderate(peer, message[0], message[1]);
		}
		if (message[0] === "LIST") {
			const meta = await this.ctx.storage.get("room");
			if (meta) ws.send(encodeWire("SERVER_LIST", [meta.name + " " + this.ctx.getWebSockets().length + "/" + meta.capacity]));
		}
	}

	async join(ws, peer, message) {
		const command = message[0];
		const create = command === "CREATE";
		if (!create && command !== "JOIN") return this.fail(ws, "Envie CREATE ou JOIN primeiro.");
		const nickname = (message[1] || "").trim();
		if (!nickname || nickname.length > 24) return this.fail(ws, "Nickname inválido.");
		let meta = await this.ctx.storage.get("room");
		if (create) {
			if (meta) return this.fail(ws, "Este código de sala já está em uso.");
			const capacity = parseInt(message[3], 10);
			const roomName = (message[4] || ("Sala de " + nickname)).trim().substring(0, 40);
			const visibility = message[5] === "public" ? "public" : "private";
			if (!Number.isFinite(capacity) || capacity < 2 || capacity > 64) return this.fail(ws, "Capacidade inválida (2 a 64).");
			meta = { id: peer.roomId, name: roomName || ("Sala de " + nickname), capacity: capacity, visibility: visibility, ownerId: "", directMode: false, skinBytes: 0 };
			peer.owner = true;
		} else {
			if (!meta) return this.fail(ws, "Sala encerrada ou código inválido.");
			if (this.ctx.getWebSockets().length >= meta.capacity) return this.fail(ws, "A sala está cheia.");
			const banned = await this.ctx.storage.get("banned") || [];
			if (banned.indexOf(nickname.toLowerCase()) >= 0) return this.fail(ws, "Nickname banido desta sala.");
		}

		peer.id = randomId();
		peer.token = randomId();
		peer.nickname = nickname;
		peer.joined = true;
		peer.roomId = peer.roomId || meta.id;
		peer.p2pReady = false;
		const candidateIp = create ? message[6] : message[3];
		const candidatePort = parseInt(create ? message[7] : message[4], 10);
		if (isValidIPv4(candidateIp) && candidateIp === peer.signalIp && Number.isFinite(candidatePort) && candidatePort > 0 && candidatePort <= 65535) {
			peer.endpointIp = candidateIp;
			peer.endpointPort = candidatePort;
		} else {
			peer.endpointIp = "";
			peer.endpointPort = 0;
		}
		if (peer.owner) meta.ownerId = peer.id;
		meta.directMode = false;
		for (const other of this.ctx.getWebSockets()) {
			if (other === ws) continue;
			const state = other.deserializeAttachment() || {};
			if (state.joined) {
				state.p2pReady = false;
				other.serializeAttachment(state);
			}
		}
		ws.serializeAttachment(peer);
		await this.ctx.storage.put("room", meta);
		await this.updateDirectory(meta);
		ws.send(encodeWire("WELCOME", [peer.id, "0", peer.token, peer.owner ? "1" : "0", meta.ownerId]));
		if (create) ws.send(encodeWire("ROOM_CREATED", []));
		this.sendRoster(ws);
		this.sendSnapshots(ws);
		this.sendPeerEndpoints(ws);
		if (!create) this.broadcastJoined(encodeWire("DIRECT_MODE", ["0"]), ws);
		if (!create) this.broadcast(encodeWire("PLAYER_JOINED", [peer.id, peer.nickname]), ws);
		if (peer.endpointIp && peer.endpointPort > 0) this.broadcastJoined(encodeWire("ENDPOINT", [peer.id, peer.nickname, peer.endpointIp, peer.endpointPort, peer.token]), ws);
	}

	async webSocketClose(ws) {
		return this.removePeer(ws);
	}

	async webSocketError(ws) {
		return this.removePeer(ws);
	}

	async removePeer(ws) {
		const peer = ws.deserializeAttachment() || {};
		if (!peer.joined) return;
		const wasOwner = !!peer.owner;
		peer.joined = false;
		peer.owner = false;
		try { ws.serializeAttachment(peer); } catch (_) { }
		const room = await this.ctx.storage.get("room");
		const peerSkins = await this.ctx.storage.list({ prefix: "skin:" + peer.id + ":" });
		let removedSkinBytes = 0;
		for (const key of peerSkins.keys()) {
			const slot = key.substring(("skin:" + peer.id + ":").length);
			const value = peerSkins.get(key);
			if (value && Number.isFinite(value.size)) removedSkinBytes += value.size;
			await this.ctx.storage.delete(key);
			this.broadcastJoined(encodeWire("SKIN_REMOVED", [peer.id, slot]), ws);
		}
		if (room && removedSkinBytes > 0) {
			room.skinBytes = Math.max(0, (Number(room.skinBytes) || 0) - removedSkinBytes);
			await this.ctx.storage.put("room", room);
		}
		if (wasOwner) {
			const candidates = [];
			for (const other of this.ctx.getWebSockets()) {
				if (other === ws) continue;
				const state = other.deserializeAttachment() || {};
				if (state.joined) candidates.push({ socket: other, peer: state });
			}

			if (room && candidates.length > 0) {
				const selected = candidates[Math.floor(Math.random() * candidates.length)];
				room.ownerId = selected.peer.id;
				room.directMode = false;
				for (const other of this.ctx.getWebSockets()) {
					const state = other.deserializeAttachment() || {};
					if (!state.joined) continue;
					state.owner = other === selected.socket;
					state.p2pReady = false;
					try { other.serializeAttachment(state); } catch (_) { }
				}
				await this.ctx.storage.put("room", room);

				const left = encodeWire("PLAYER_LEFT", [peer.id]);
				const changed = encodeWire("HOST_CHANGED", [selected.peer.id, selected.peer.nickname, room.name, room.capacity]);
				const directMode = encodeWire("DIRECT_MODE", ["0"]);
				for (const other of this.ctx.getWebSockets()) {
					if (other === ws) continue;
					const state = other.deserializeAttachment() || {};
					if (!state.joined) continue;
					try { other.send(left); other.send(changed); other.send(directMode); } catch (_) { }
				}
				await this.updateDirectory(room);
				return;
			}

			await this.ctx.storage.delete("room");
			await this.ctx.storage.delete("banned");
			const storedSkins = await this.ctx.storage.list({ prefix: "skin:" });
			for (const key of storedSkins.keys()) await this.ctx.storage.delete(key);
			await this.updateDirectory(null, peer.roomId);
			for (const other of this.ctx.getWebSockets()) {
				if (other === ws) continue;
				try { other.send(encodeWire("ERROR", ["O host saiu e a sala não pôde ser transferida."])); other.close(1000, "room closed"); } catch (_) { }
			}
			return;
		}

		this.broadcast(encodeWire("PLAYER_LEFT", [peer.id]), ws);
		if (room) {
			await this.disableDirectMode(peer.roomId);
			await this.updateDirectory(room);
		}
	}

	async handleSkinRequest(request, url) {
		const roomId = url.searchParams.get("room");
		const playerId = request.headers.get("X-HTS-Player") || "";
		const token = request.headers.get("X-HTS-Token") || "";
		if (!roomId || !ROOM_ID_RE.test(roomId) || !playerId || !token) return new Response("Unauthorized", { status: 401 });
		let authenticated = false;
		for (const socket of this.ctx.getWebSockets()) {
			const peer = socket.deserializeAttachment() || {};
			if (peer.joined && peer.id === playerId && peer.token === token) { authenticated = true; break; }
		}
		if (!authenticated) return new Response("Unauthorized", { status: 401 });
		const targetPlayer = url.searchParams.get("player");
		const slot = url.searchParams.get("slot");
		if (!targetPlayer || !slot) {
			if (request.method !== "GET") return new Response("Bad request", { status: 400 });
			const entries = await this.ctx.storage.list({ prefix: "skin:" });
			const manifest = [];
			for (const [key, value] of entries) {
				const parts = key.split(":");
				if (parts.length !== 3 || !value) continue;
				manifest.push({ playerId: parts[1], slot: parts[2], hash: value.hash, size: value.size, type: value.type, model: value.model || "" });
			}
			return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
		}
		if (!ROOM_ID_RE.test(targetPlayer) || !/^[A-Za-z0-9_-]{1,48}$/.test(slot)) return new Response("Bad request", { status: 400 });
		const key = "skin:" + targetPlayer + ":" + slot;
		if (request.method === "DELETE") {
			if (targetPlayer !== playerId) return new Response("Forbidden", { status: 403 });
			const old = await this.ctx.storage.get(key);
			await this.ctx.storage.delete(key);
			const room = await this.ctx.storage.get("room");
			if (room && old && Number.isFinite(old.size)) {
				room.skinBytes = Math.max(0, (Number(room.skinBytes) || 0) - old.size);
				await this.ctx.storage.put("room", room);
			}
			if (old) this.broadcastJoined(encodeWire("SKIN_REMOVED", [playerId, slot]), null);
			return new Response("deleted", { status: 200 });
		}
		if (request.method === "PUT") {
			if (targetPlayer !== playerId) return new Response("Forbidden", { status: 403 });
			const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
			if (type !== "image/png" && type !== "image/jpeg") return new Response("Only PNG/JPEG skins are accepted", { status: 415 });
			const declaredSize = Number(request.headers.get("Content-Length") || 0);
			// Leave headroom below the Durable Object's 8 MB key+value limit for metadata.
			if (declaredSize > 7 * 1024 * 1024) return new Response("Skin exceeds 7 MB", { status: 413 });
			let image;
			try { image = await readSkinBody(request, 7 * 1024 * 1024); }
			catch (error) { return new Response(error.message || "Invalid skin size", { status: error.statusCode || 400 }); }
			if (image.byteLength < 16) return new Response("Invalid skin size", { status: 413 });
			const png = image.length >= 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47 && image[4] === 0x0d && image[5] === 0x0a && image[6] === 0x1a && image[7] === 0x0a;
			const jpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
			if ((type === "image/png" && !png) || (type === "image/jpeg" && !jpeg)) return new Response("Image signature does not match Content-Type", { status: 415 });
			const model = (request.headers.get("X-HTS-Model") || "").replace(/[^A-Za-z0-9 _().-]/g, "_").substring(0, 64);
			const digest = await crypto.subtle.digest("SHA-256", image);
			const hash = Array.from(new Uint8Array(digest)).map(function (value) { return value.toString(16).padStart(2, "0"); }).join("");
			const room = await this.ctx.storage.get("room");
			if (!room) return new Response("Room is closed", { status: 404 });
			const old = await this.ctx.storage.get(key);
			const peerEntries = await this.ctx.storage.list({ prefix: "skin:" + playerId + ":" });
			let playerBytes = 0;
			for (const value of peerEntries.values()) if (value && Number.isFinite(value.size)) playerBytes += value.size;
			const nextPlayerBytes = playerBytes - (old && Number.isFinite(old.size) ? old.size : 0) + image.byteLength;
			const nextRoomBytes = (Number(room.skinBytes) || 0) - (old && Number.isFinite(old.size) ? old.size : 0) + image.byteLength;
			if (nextPlayerBytes > 12 * 1024 * 1024) return new Response("Player skin cache is limited to 12 MB", { status: 413 });
			if (nextRoomBytes > 768 * 1024 * 1024) return new Response("Room skin cache is full", { status: 413 });
			await this.ctx.storage.put(key, { bytes: image, hash: hash, size: image.byteLength, type: type, model: model });
			room.skinBytes = nextRoomBytes;
			await this.ctx.storage.put("room", room);
			this.broadcastJoined(encodeWire("SKIN_AVAILABLE", [playerId, slot, hash, image.byteLength, type, model]), null);
			return new Response(JSON.stringify({ hash: hash, size: image.byteLength }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
		}
		const stored = await this.ctx.storage.get(key);
		if (!stored || !stored.bytes) return new Response("Not found", { status: 404 });
		return new Response(stored.bytes, { headers: { "content-type": stored.type, "content-length": String(stored.size), "x-hts-sha256": stored.hash, "cache-control": "no-store" } });
	}

	async deletePeerSkins(playerId) {
		if (!playerId) return;
		const entries = await this.ctx.storage.list({ prefix: "skin:" + playerId + ":" });
		for (const key of entries.keys()) await this.ctx.storage.delete(key);
	}

	async sendSkinManifest(target) {
		const entries = await this.ctx.storage.list({ prefix: "skin:" });
		for (const [key, value] of entries) {
			const parts = key.split(":");
			if (parts.length !== 3 || !value) continue;
			try { target.send(encodeWire("SKIN_AVAILABLE", [parts[1], parts[2], value.hash, value.size, value.type, value.model || ""])); } catch (_) { return; }
		}
	}

	async disableDirectMode(roomId) {
		const room = await this.ctx.storage.get("room");
		if (!room || room.id !== roomId) return;
		room.directMode = false;
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() || {};
			if (state.joined) {
				state.p2pReady = false;
				socket.serializeAttachment(state);
			}
		}
		await this.ctx.storage.put("room", room);
		this.broadcastJoined(encodeWire("DIRECT_MODE", ["0"]), null);
	}

	async moderate(owner, command, targetId) {
		for (const ws of this.ctx.getWebSockets()) {
			const target = ws.deserializeAttachment() || {};
			if (target.id !== targetId || target.owner) continue;
			if (command === "BAN") {
				const banned = await this.ctx.storage.get("banned") || [];
				if (banned.indexOf(target.nickname.toLowerCase()) < 0) banned.push(target.nickname.toLowerCase());
				await this.ctx.storage.put("banned", banned);
			}
			try { ws.send(encodeWire("ERROR", [command === "BAN" ? "Banido pelo dono da sala." : "Expulso pelo dono da sala."])); ws.close(1008, command); } catch (_) { }
		}
	}

	sendRoster(target) {
		const fields = [];
		for (const ws of this.ctx.getWebSockets()) {
			const peer = ws.deserializeAttachment() || {};
			if (peer.joined) fields.push(peer.id, peer.nickname);
		}
		target.send(encodeWire("ROSTER", fields));
	}

	sendSnapshots(target) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === target) continue;
			const peer = ws.deserializeAttachment() || {};
			if (!peer.joined || !peer.lastMove) continue;
			const truck = [peer.id, peer.nickname].concat(peer.lastMove, [peer.owner ? "1" : "0"]);
			if (truck.length > 11 && peer.lastState) truck[11] = peer.lastState;
			try { target.send(encodeWire("TRUCK", truck)); } catch (_) { }
		}
	}

	sendPeerEndpoints(target) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === target) continue;
			const peer = ws.deserializeAttachment() || {};
			if (!peer.joined || !peer.endpointIp || !peer.endpointPort) continue;
			try { target.send(encodeWire("ENDPOINT", [peer.id, peer.nickname, peer.endpointIp, peer.endpointPort, peer.token])); } catch (_) { }
		}
	}

	broadcastJoined(line, excluded) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === excluded) continue;
			const peer = ws.deserializeAttachment() || {};
			if (!peer.joined) continue;
			try { ws.send(line); } catch (_) { }
		}
	}

	broadcast(line, excluded) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === excluded) continue;
			try { ws.send(line); } catch (_) { }
		}
	}

	fail(ws, text) {
		try { ws.send(encodeWire("ERROR", [text])); ws.close(1008, "rejected"); } catch (_) { }
	}

	async updateDirectory(meta, removeId) {
		const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
		const body = meta ? JSON.stringify({ id: meta.id, name: meta.name, capacity: meta.capacity, count: this.ctx.getWebSockets().filter(function (ws) { const peer = ws.deserializeAttachment() || {}; return peer.joined; }).length, visibility: meta.visibility }) : JSON.stringify({ id: removeId });
		await directory.fetch(meta ? "https://directory/upsert" : "https://directory/remove", { method: "POST", body: body });
	}
}

export class Directory {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/list") {
			const values = await this.ctx.storage.list({ prefix: "room:" });
			const lines = [];
			for (const entry of values.values()) {
				const room = entry;
				if (room.visibility !== "public" || room.count < 1) continue;
				lines.push([b64(room.id), b64(room.name), room.count, room.capacity].join("|"));
			}
			return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
		}
		if (request.method === "POST" && (url.pathname === "/upsert" || url.pathname === "/remove")) {
			let body;
			try { body = await request.json(); } catch (_) { return new Response("Bad request", { status: 400 }); }
			if (!body || !ROOM_ID_RE.test(body.id || "")) return new Response("Bad room id", { status: 400 });
			if (url.pathname === "/remove") await this.ctx.storage.delete("room:" + body.id);
			else if (body.visibility === "public" && body.count > 0) await this.ctx.storage.put("room:" + body.id, body);
			else await this.ctx.storage.delete("room:" + body.id);
			return new Response("ok");
		}
		return new Response("Not found", { status: 404 });
	}
}

function decodeWire(line) {
	try {
		const parts = line.split("\t");
		return [parts[0]].concat(parts.slice(1).map(function (part) { return fromB64(part); }));
	} catch (_) { return null; }
}

function encodeWire(command, fields) {
	return [command].concat((fields || []).map(function (value) { return b64(value == null ? "" : String(value)); })).join("\t");
}

function b64(text) {
	const bytes = new TextEncoder().encode(String(text));
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function fromB64(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function randomId() {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes).map(function (value) { return value.toString(16).padStart(2, "0"); }).join("").toUpperCase();
}

function isValidIPv4(value) {
	if (typeof value !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
	const octets = value.split(".");
	for (let i = 0; i < octets.length; i++) {
		const octet = Number(octets[i]);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
	}
	return true;
}
