/**
 * Parser for the mapblock files written by `export_mapblock` in
 * worldmods/export_mod/export.lua
 *
 * File layout (json):
 *   node_mapping: node name -> content id (only the nodes used in this mapblock)
 *   mapdata:      base64 (unpadded) of the zlib-compressed binary payload
 *
 * Payload layout (16384 bytes):
 *   [    0 ..  8191] 4096 * uint16 (little endian) content ids
 *   [ 8192 .. 12287] 4096 * uint8 param1 (light)
 *   [12288 .. 16383] 4096 * uint8 param2
 *
 * Nodes are stored in VoxelArea order: index = z * 256 + y * 16 + x
 */

/** edge length of a mapblock in nodes */
export const MAPBLOCK_SIZE = 16
/** number of nodes in a mapblock */
export const MAPBLOCK_VOLUME = MAPBLOCK_SIZE * MAPBLOCK_SIZE * MAPBLOCK_SIZE
/** size of the uncompressed payload in bytes: uint16 ids + uint8 param1 + uint8 param2 */
export const MAPDATA_LENGTH = MAPBLOCK_VOLUME * 4

const PARAM1_OFFSET = MAPBLOCK_VOLUME * 2
const PARAM2_OFFSET = MAPBLOCK_VOLUME * 3

/** the mapblock as exported, the node mapping may be a plain json object or a Map */
export type RawMapblock = {
    mapdata: string
    node_mapping: Record<string, number> | Map<string, number>
}

export type Node = {
    name: string
    param1: number
    param2: number
}

export class MapblockParseError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = "MapblockParseError"
    }
}

/** index of a node inside the mapblock, coordinates are relative to the mapblock (0..15) */
export function getNodeIndex(x: number, y: number, z: number): number {
    if (!isNodeCoordinate(x) || !isNodeCoordinate(y) || !isNodeCoordinate(z)) {
        throw new RangeError(`node position out of range: (${x},${y},${z})`)
    }
    return z * MAPBLOCK_SIZE * MAPBLOCK_SIZE + y * MAPBLOCK_SIZE + x
}

function isNodeCoordinate(v: number): boolean {
    return Number.isInteger(v) && v >= 0 && v < MAPBLOCK_SIZE
}

export class ParsedMapblock {
    constructor(
        /** content id per node */
        readonly nodeIds: Uint16Array,
        /** param1 (light) per node */
        readonly param1: Uint8Array,
        /** param2 per node */
        readonly param2: Uint8Array,
        /** content id -> node name */
        readonly nodeNames: ReadonlyMap<number, string>
    ) {}

    getNodeId(x: number, y: number, z: number): number {
        return this.nodeIds[getNodeIndex(x, y, z)]!
    }

    getNodeName(x: number, y: number, z: number): string {
        return this.nodeNames.get(this.getNodeId(x, y, z))!
    }

    getParam1(x: number, y: number, z: number): number {
        return this.param1[getNodeIndex(x, y, z)]!
    }

    getParam2(x: number, y: number, z: number): number {
        return this.param2[getNodeIndex(x, y, z)]!
    }

    getNode(x: number, y: number, z: number): Node {
        const index = getNodeIndex(x, y, z)
        return {
            name: this.nodeNames.get(this.nodeIds[index]!)!,
            param1: this.param1[index]!,
            param2: this.param2[index]!
        }
    }
}

/** parses an exported mapblock, accepts the json text or the already decoded object */
export async function parseMapblock(input: string | RawMapblock): Promise<ParsedMapblock> {
    const raw = typeof input === "string" ? parseJson(input) : input
    validateRawMapblock(raw)

    const data = await inflate(decodeBase64(raw.mapdata))
    if (data.length !== MAPDATA_LENGTH) {
        throw new MapblockParseError(`unexpected mapdata length: ${data.length}, expected ${MAPDATA_LENGTH}`)
    }

    // explicit little-endian read, independent of the host byte order
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const nodeIds = new Uint16Array(MAPBLOCK_VOLUME)
    for (let i = 0; i < MAPBLOCK_VOLUME; i++) {
        nodeIds[i] = view.getUint16(i * 2, true)
    }

    const nodeNames = invertNodeMapping(raw.node_mapping)
    for (const id of nodeIds) {
        if (!nodeNames.has(id)) {
            throw new MapblockParseError(`content id ${id} is missing in the node mapping`)
        }
    }

    return new ParsedMapblock(
        nodeIds,
        data.slice(PARAM1_OFFSET, PARAM2_OFFSET),
        data.slice(PARAM2_OFFSET, MAPDATA_LENGTH),
        nodeNames
    )
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch (e) {
        throw new MapblockParseError("mapblock is not valid json", { cause: e })
    }
}

function validateRawMapblock(raw: unknown): asserts raw is RawMapblock {
    if (typeof raw !== "object" || raw === null) {
        throw new MapblockParseError("mapblock is not an object")
    }
    const { mapdata, node_mapping } = raw as Partial<RawMapblock>
    if (typeof mapdata !== "string") {
        throw new MapblockParseError("mapblock has no 'mapdata' string")
    }
    if (typeof node_mapping !== "object" || node_mapping === null) {
        throw new MapblockParseError("mapblock has no 'node_mapping' object")
    }
}

function invertNodeMapping(mapping: RawMapblock["node_mapping"]): Map<number, string> {
    const entries = mapping instanceof Map ? mapping.entries() : Object.entries(mapping)
    const names = new Map<number, string>()
    for (const [name, id] of entries) {
        if (!Number.isInteger(id) || id < 0 || id > 0xffff) {
            throw new MapblockParseError(`invalid content id for node '${name}': ${id}`)
        }
        names.set(id, name)
    }
    return names
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
    let binary: string
    try {
        // atob accepts the unpadded output of minetest.encode_base64
        binary = atob(base64)
    } catch (e) {
        throw new MapblockParseError("mapdata is not valid base64", { cause: e })
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

/** minetest.compress(data, "deflate") emits a zlib stream, which is the "deflate" format of the web api */
async function inflate(compressed: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))
    try {
        return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch (e) {
        throw new MapblockParseError("mapdata could not be decompressed", { cause: e })
    }
}
