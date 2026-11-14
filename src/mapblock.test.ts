import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import {
    getNodeIndex,
    MAPBLOCK_VOLUME,
    MAPDATA_LENGTH,
    MapblockParseError,
    parseMapblock
} from "./mapblock"

const fixture = readFileSync(join(__dirname, "testdata/mapblock_6_0_0.json"), "utf-8")

/** builds an export file the same way export.lua does */
function encode(payload: Uint8Array, node_mapping: Record<string, number>, padding = false) {
    const base64 = deflateSync(payload).toString("base64")
    return { mapdata: padding ? base64 : base64.replace(/=+$/, ""), node_mapping }
}

function buildPayload(fill: (index: number) => [id: number, param1: number, param2: number]): Uint8Array {
    const payload = new Uint8Array(MAPDATA_LENGTH)
    for (let i = 0; i < MAPBLOCK_VOLUME; i++) {
        const [id, param1, param2] = fill(i)
        payload[i * 2] = id & 0xff
        payload[i * 2 + 1] = id >> 8
        payload[MAPBLOCK_VOLUME * 2 + i] = param1
        payload[MAPBLOCK_VOLUME * 3 + i] = param2
    }
    return payload
}

describe("getNodeIndex", () => {
    it("uses the VoxelArea order (x fastest, z slowest)", () => {
        expect(getNodeIndex(0, 0, 0)).toBe(0)
        expect(getNodeIndex(1, 0, 0)).toBe(1)
        expect(getNodeIndex(0, 1, 0)).toBe(16)
        expect(getNodeIndex(0, 0, 1)).toBe(256)
        expect(getNodeIndex(15, 15, 15)).toBe(4095)
    })

    it("rejects positions outside of the mapblock", () => {
        expect(() => getNodeIndex(16, 0, 0)).toThrow(RangeError)
        expect(() => getNodeIndex(0, -1, 0)).toThrow(RangeError)
        expect(() => getNodeIndex(0, 0, 1.5)).toThrow(RangeError)
    })
})

describe("parseMapblock", () => {
    it("parses an exported mapblock", async () => {
        const mb = await parseMapblock(fixture)

        expect(mb.nodeIds).toHaveLength(MAPBLOCK_VOLUME)
        expect(mb.param1).toHaveLength(MAPBLOCK_VOLUME)
        expect(mb.param2).toHaveLength(MAPBLOCK_VOLUME)
        expect(mb.nodeNames.size).toBe(17)
        expect(mb.nodeNames.get(126)).toBe("air")
        expect(mb.nodeNames.get(317)).toBe("flowers:dandelion_white")

        // reference values, decoded independently from the lua export
        const counts = new Map<string, number>()
        for (const id of mb.nodeIds) {
            const name = mb.nodeNames.get(id)!
            counts.set(name, (counts.get(name) ?? 0) + 1)
        }
        expect(counts.get("air")).toBe(2295)
        expect(counts.get("default:sand")).toBe(1099)
        expect(counts.get("default:stone")).toBe(464)
        expect(counts.get("flowers:dandelion_white")).toBe(1)

        expect(mb.param1.filter(v => v === 15)).toHaveLength(2425)
        expect(mb.param1.filter(v => v === 0)).toHaveLength(1671)
        expect(mb.param2.every(v => v === 0)).toBe(true)

        expect(mb.getNode(0, 0, 0)).toEqual({ name: "default:stone", param1: 0, param2: 0 })
        expect(mb.getNode(15, 15, 15)).toEqual({ name: "air", param1: 15, param2: 0 })
    })

    it("accepts an already decoded object and a Map as node mapping", async () => {
        const json = JSON.parse(fixture)
        const fromObject = await parseMapblock(json)
        const fromMap = await parseMapblock({
            mapdata: json.mapdata,
            node_mapping: new Map<string, number>(Object.entries(json.node_mapping))
        })
        expect(fromMap.nodeIds).toEqual(fromObject.nodeIds)
        expect(fromMap.nodeNames).toEqual(fromObject.nodeNames)
    })

    it("decodes ids, param1 and param2 at the right positions", async () => {
        // ids above 255 exercise the little-endian uint16 decoding
        const payload = buildPayload(i => [i % 2 === 0 ? 1 : 0x1234, i % 256, 255 - (i % 256)])
        const mapping = { "default:stone": 1, "test:node": 0x1234 }

        for (const padding of [false, true]) {
            const mb = await parseMapblock(encode(payload, mapping, padding))
            expect(mb.getNodeId(0, 0, 0)).toBe(1)
            expect(mb.getNodeId(1, 0, 0)).toBe(0x1234)
            expect(mb.getNodeName(1, 0, 0)).toBe("test:node")
            expect(mb.getNodeName(0, 1, 0)).toBe("default:stone")
            expect(mb.getParam1(3, 2, 1)).toBe((256 + 32 + 3) % 256)
            expect(mb.getParam2(3, 2, 1)).toBe(255 - ((256 + 32 + 3) % 256))
            expect(mb.getNode(15, 15, 15)).toEqual({ name: "test:node", param1: 255, param2: 0 })
        }
    })

    it("rejects malformed input", async () => {
        const payload = buildPayload(() => [1, 0, 0])
        const valid = encode(payload, { "default:stone": 1 })

        await expect(parseMapblock("{")).rejects.toThrow(MapblockParseError)
        await expect(parseMapblock("null")).rejects.toThrow(MapblockParseError)
        await expect(parseMapblock("{}")).rejects.toThrow(/mapdata/)
        await expect(parseMapblock({ mapdata: valid.mapdata } as never)).rejects.toThrow(/node_mapping/)
        await expect(parseMapblock({ ...valid, mapdata: "%%%" })).rejects.toThrow(/base64/)
        await expect(parseMapblock({ ...valid, mapdata: "AAAAAAAA" })).rejects.toThrow(/decompress/)
        await expect(parseMapblock(encode(payload.slice(0, 100), valid.node_mapping))).rejects.toThrow(/length/)
        await expect(parseMapblock({ ...valid, node_mapping: {} })).rejects.toThrow(/content id 1 is missing/)
        await expect(parseMapblock({ ...valid, node_mapping: { a: 1.5 } })).rejects.toThrow(/invalid content id/)
    })
})
