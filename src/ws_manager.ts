import { WebSocket } from "ws";
import { AbstractPacket, PacketPing } from "./interface";

export class WsManager<Message extends AbstractPacket> {
  rooms: Map<string, Set<WebSocket>> = new Map()


  constructor (public keepAliveMs: number = 30000) {
    setInterval(() => {
      const msg: PacketPing = {
        type: 'ping',
        id: -1,
      }

      for (const [, room] of this.rooms) {
        for (const ws of room) {
          try {
            ws.send(JSON.stringify(msg))
          } catch (err) {}
        }
      }
    }, keepAliveMs)
  }

  addManagedSocket(roomName: string, ws: WebSocket) {
    let room: Set<WebSocket>
    if (!this.rooms.has(roomName)) {
      room = new Set()
      this.rooms.set(roomName, room)
    } else {
      room = this.rooms.get(roomName)!
    }

    room.add(ws)

    ws.on('error', () => {
      try {
        ws.close(1001)
      } catch (err) {}
      this.removeSocket(roomName, ws)
    })

    ws.on('close', () => {
      this.removeSocket(roomName, ws)
    })
  }
  
  removeSocket (roomName: string, ws: WebSocket) {
    if (this.rooms.get(roomName)?.has(ws)) {
      console.log(`${roomName}: [WS] disconnecting a user`)
      this.rooms.get(roomName)?.delete(ws)
    }
  }

  broadcast (roomName: string, msg: Message) {
    this.rooms.get(roomName)?.forEach(ws => {
      try {
        ws.send(JSON.stringify(msg))
      } catch (err) {}
    })
  }
}