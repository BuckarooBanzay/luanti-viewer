/**
 * Converts the nodes of a mapblock into triangle meshes, one per tile.
 *
 * This is a port of the mesh generator of the luanti engine
 * (src/client/content_mapblock.cpp), all geometry is emitted in the conventions
 * of the engine: left-handed coordinates, one unit per node, texture origin in
 * the top left corner. The viewer converts the result for three.js.
 */
import type { Box } from "../types.js"
import { CONTENT_IGNORE, repairBox, type NodeInfo, type NodeRegistry } from "./nodes.js"
import {
    applyMat3, facedirMatrix, FACEDIR_TILES, multiply, rotationXY, rotationXZ, rotationYZ, WALLMOUNTED_TO_FACEDIR,
    type Mat3
} from "./rotation.js"

/** edge length of the padded node arrays: a mapblock plus one node on each side */
export const PADDED_SIZE = 18
export const PADDED_VOLUME = PADDED_SIZE * PADDED_SIZE * PADDED_SIZE

const DX = 1
const DY = PADDED_SIZE
const DZ = PADDED_SIZE * PADDED_SIZE

/** index into the padded arrays, coordinates are relative to the mapblock (-1..16) */
export function paddedIndex(x: number, y: number, z: number): number {
    return (z + 1) * DZ + (y + 1) * DY + (x + 1) * DX
}

/** the nodes of a mapblock and the adjacent nodes of its neighbors */
export type Neighborhood = {
    /** internal content ids, CONTENT_IGNORE where no mapblock is loaded */
    ids: Uint16Array
    param1: Uint8Array
    param2: Uint8Array
}

export function createNeighborhood(): Neighborhood {
    return {
        ids: new Uint16Array(PADDED_VOLUME),
        param1: new Uint8Array(PADDED_VOLUME),
        param2: new Uint8Array(PADDED_VOLUME)
    }
}

/** triangles of a single tile */
export class MeshBuffer {
    /** xyz per vertex, relative to the minimum corner of the mapblock, node centers are at integer positions */
    positions: number[] = []
    /** uv per vertex, v = 0 is the top of the texture */
    uvs: number[] = []
    /** linear rgb per vertex at full daylight */
    colors: number[] = []
    /** brightness at night relative to the one at day (0..1, gamma space) per vertex */
    nightFactors: number[] = []
    indices: number[] = []

    get vertexCount(): number {
        return this.positions.length / 3
    }
}

// face order of cuboids: top, bottom, right, left, back, front (+y, -y, +x, -x, +z, -z)
const FACE_OFFSETS = [DY, -DY, DX, -DX, DZ, -DZ]
const FACE_NORMALS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const
/** direction index for FACEDIR_TILES: (x + 2*y + 3*z) & 7 */
const FACE_DIR_INDEX = [2, 6, 1, 7, 3, 5]
/** which corner (0 = min, 1 = max) every vertex of a cuboid face uses, see setupCuboidVertices */
const FACE_CORNERS = [
    [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0],
    [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
    [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 0],
    [0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
    [0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0]
] as const

// connection order of connected nodeboxes: top, bottom, front, left, back, right
const CONNECTION_OFFSETS = [DY, -DY, -DZ, -DX, DZ, DX]

// g_6dirs / g_26dirs of the engine (first 18 entries)
const DIRS_26 = [
    [0, 0, 1], [0, 1, 0], [1, 0, 0], [0, 0, -1], [0, -1, 0], [-1, 0, 0],
    [-1, 1, 0], [1, 1, 0], [0, 1, 1], [0, 1, -1],
    [-1, 0, 1], [1, 0, 1], [-1, 0, -1], [1, 0, -1],
    [-1, -1, 0], [1, -1, 0], [0, -1, 1], [0, -1, -1]
] as const
const D6_ZP = 0, D6_YP = 1, D6_XP = 2, D6_ZN = 3, D6_YN = 4, D6_XN = 5

// wallmounted directions
const DWM_YP = 0, DWM_YN = 1, DWM_XP = 2, DWM_XN = 3, DWM_ZP = 4, DWM_ZN = 5, DWM_S1 = 6, DWM_S2 = 7

const UNIT_BOX: Box = [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]
const DEFAULT_UV = [0, 0, 1, 0, 1, 1, 0, 1]

/** brightness (0..1) per light level, see src/light.cpp with the default settings of the engine */
export const LIGHT_CURVE: readonly number[] = (() => {
    const alpha = 0, beta = 1.5, boost = 0.2, center = 0.5, sigma = 0.2
    const a = alpha + beta - 2, b = 3 - 2 * alpha - beta, c = alpha
    const curve: number[] = []
    for (let i = 0; i <= 15; i++) {
        const x = i / 15
        let brightness = 1
        if (i === 0) {
            brightness = 0
        } else if (i < 15) {
            brightness = ((a * x + b) * x + c) * x + boost * Math.exp(-0.5 * ((x - center) / sigma) ** 2)
            brightness = Math.min(Math.max(brightness, 0), 1)
        }
        curve.push(brightness)
    }
    return curve
})()

/** minimum brightness, keeps unlit caves visible */
const AMBIENT = 0.1

/** combines two packed light values (day | night << 4), each bank on its own */
function maxLight(a: number, b: number): number {
    return Math.max(a & 0x0f, b & 0x0f) | Math.max(a & 0xf0, b & 0xf0)
}

/**
 * brightness at night relative to the one at day (gamma space) per packed light value,
 * independent of the face shading as that is a common factor
 */
export const NIGHT_FACTOR: readonly number[] = (() => {
    const factors: number[] = []
    for (let light = 0; light < 256; light++) {
        const day = AMBIENT + (1 - AMBIENT) * LIGHT_CURVE[light & 0x0f]!
        const night = AMBIENT + (1 - AMBIENT) * LIGHT_CURVE[light >> 4]!
        factors.push(Math.min(night / day, 1))
    }
    return factors
})()

/** see applyFacesShading in the engine */
function faceShade(nx: number, ny: number, nz: number): number {
    const x2 = nx * nx, y2 = ny * ny, z2 = nz * nz
    if (ny < 0) {
        return 0.670820 * x2 + 0.447213 * y2 + 0.836660 * z2
    }
    if (x2 > 1e-3 || z2 > 1e-3) {
        return 0.670820 * x2 + y2 + 0.836660 * z2
    }
    return 1
}

/** the pseudo random generator of the engine (src/noise.h) */
class PseudoRandom {
    private state: number

    constructor(seed: number) {
        this.state = seed | 0
    }

    next(): number {
        this.state = (Math.imul(this.state, 1103515245) + 12345) | 0
        return (Math.trunc(this.state / 65536) >>> 0) % 32768
    }
}

const RAIL_DIRECTIONS = [[0, 1], [0, -1], [-1, 0], [1, 0]] as const // x, z
const RAIL_SLOPE_ANGLES = [0, 180, 90, -90]
const RAIL_STRAIGHT = 0, RAIL_CURVED = 1, RAIL_JUNCTION = 2, RAIL_CROSS = 3
/** index bits: +z, -z, -x, +x -> [tile, angle] */
const RAIL_KINDS = [
    [RAIL_STRAIGHT, 0], [RAIL_STRAIGHT, 0], [RAIL_STRAIGHT, 0], [RAIL_STRAIGHT, 0],
    [RAIL_STRAIGHT, 90], [RAIL_CURVED, 180], [RAIL_CURVED, 270], [RAIL_JUNCTION, 180],
    [RAIL_STRAIGHT, 90], [RAIL_CURVED, 90], [RAIL_CURVED, 0], [RAIL_JUNCTION, 0],
    [RAIL_STRAIGHT, 90], [RAIL_JUNCTION, 90], [RAIL_JUNCTION, 270], [RAIL_CROSS, 0]
] as const

// framed glass
const FRAME_A = 0.5
const FRAME_G = 0.5 - 0.003
const FRAME_B = 0.876 * 0.5
const FRAME_EDGES: Box[] = [
    [FRAME_B, FRAME_B, -FRAME_A, FRAME_A, FRAME_A, FRAME_A], // y+
    [-FRAME_A, FRAME_B, -FRAME_A, -FRAME_B, FRAME_A, FRAME_A], // y+
    [FRAME_B, -FRAME_A, -FRAME_A, FRAME_A, -FRAME_B, FRAME_A], // y-
    [-FRAME_A, -FRAME_A, -FRAME_A, -FRAME_B, -FRAME_B, FRAME_A], // y-
    [FRAME_B, -FRAME_A, FRAME_B, FRAME_A, FRAME_A, FRAME_A], // x+
    [FRAME_B, -FRAME_A, -FRAME_A, FRAME_A, FRAME_A, -FRAME_B], // x+
    [-FRAME_A, -FRAME_A, FRAME_B, -FRAME_B, FRAME_A, FRAME_A], // x-
    [-FRAME_A, -FRAME_A, -FRAME_A, -FRAME_B, FRAME_A, -FRAME_B], // x-
    [-FRAME_A, FRAME_B, FRAME_B, FRAME_A, FRAME_A, FRAME_A], // z+
    [-FRAME_A, -FRAME_A, FRAME_B, FRAME_A, -FRAME_B, FRAME_A], // z+
    [-FRAME_A, -FRAME_A, -FRAME_A, FRAME_A, -FRAME_B, -FRAME_B], // z-
    [-FRAME_A, FRAME_B, -FRAME_A, FRAME_A, FRAME_A, -FRAME_B] // z-
]
/** two adjacent neighbors and the diagonal neighbor of every frame edge (indices into DIRS_26) */
const FRAME_NEIGHBORS = [
    [1, 2, 7], [1, 5, 6], [4, 2, 15], [4, 5, 14],
    [2, 0, 11], [2, 3, 13], [5, 0, 10], [5, 3, 12],
    [0, 1, 8], [0, 4, 16], [3, 4, 17], [3, 1, 9]
] as const

// fences
const POST_RADIUS = 1 / 8
const BAR_RADIUS = 1 / 16
const BAR_LENGTH = 0.5 - POST_RADIUS
const FENCE_POST: Box = [-POST_RADIUS, -0.5, -POST_RADIUS, POST_RADIUS, 0.5, POST_RADIUS]
const FENCE_POST_UV = [
    0.375, 0.375, 0.625, 0.625,
    0.375, 0.375, 0.625, 0.625,
    0.000, 0.000, 0.250, 1.000,
    0.250, 0.000, 0.500, 1.000,
    0.500, 0.000, 0.750, 1.000,
    0.750, 0.000, 1.000, 1.000
]
const FENCE_BARS_X: Box[] = [
    [0.5 - BAR_LENGTH, 0.25 - BAR_RADIUS, -BAR_RADIUS, 0.5 + BAR_LENGTH, 0.25 + BAR_RADIUS, BAR_RADIUS],
    [0.5 - BAR_LENGTH, -0.25 - BAR_RADIUS, -BAR_RADIUS, 0.5 + BAR_LENGTH, -0.25 + BAR_RADIUS, BAR_RADIUS]
]
const FENCE_BARS_X_UV = [
    0.000, 0.125, 1.000, 0.250,
    0.000, 0.250, 1.000, 0.375,
    0.375, 0.375, 0.500, 0.500,
    0.625, 0.625, 0.750, 0.750,
    0.000, 0.500, 1.000, 0.625,
    0.000, 0.875, 1.000, 1.000
]
const FENCE_BARS_Z: Box[] = [
    [-BAR_RADIUS, 0.25 - BAR_RADIUS, 0.5 - BAR_LENGTH, BAR_RADIUS, 0.25 + BAR_RADIUS, 0.5 + BAR_LENGTH],
    [-BAR_RADIUS, -0.25 - BAR_RADIUS, 0.5 - BAR_LENGTH, BAR_RADIUS, -0.25 + BAR_RADIUS, 0.5 + BAR_LENGTH]
]
const FENCE_BARS_Z_UV = [
    0.1875, 0.0625, 0.3125, 0.3125,
    0.2500, 0.0625, 0.3750, 0.3125,
    0.0000, 0.5625, 1.0000, 0.6875,
    0.0000, 0.3750, 1.0000, 0.5000,
    0.3750, 0.3750, 0.5000, 0.5000,
    0.6250, 0.6250, 0.7500, 0.7500
]

// liquids
const LIQUID_FACES = [
    { dx: 1, dz: 0, p: [[1, 1], [1, 0]] },
    { dx: -1, dz: 0, p: [[0, 0], [0, 1]] },
    { dx: 0, dz: 1, p: [[0, 1], [1, 1]] },
    { dx: 0, dz: -1, p: [[1, 0], [0, 0]] }
] as const
const LIQUID_VERTICES = [[0, 1], [1, 1], [1, 0], [0, 0]] as const

// plantlike mesh options
const PLANT_STYLE_CROSS = 0, PLANT_STYLE_CROSS2 = 1, PLANT_STYLE_STAR = 2, PLANT_STYLE_HASH = 3, PLANT_STYLE_HASH2 = 4

/** texture coordinates of a nodebox, aligned to those of a full node, see generateCuboidTextureCoords */
function boxTextureCoords(b: ArrayLike<number>, out: number[]): number[] {
    const tx1 = b[0]! + 0.5, ty1 = b[1]! + 0.5, tz1 = b[2]! + 0.5
    const tx2 = b[3]! + 0.5, ty2 = b[4]! + 0.5, tz2 = b[5]! + 0.5
    out[0] = tx1; out[1] = 1 - tz2; out[2] = tx2; out[3] = 1 - tz1 // up
    out[4] = tx1; out[5] = tz1; out[6] = tx2; out[7] = tz2 // down
    out[8] = tz1; out[9] = 1 - ty2; out[10] = tz2; out[11] = 1 - ty1 // right
    out[12] = 1 - tz2; out[13] = 1 - ty2; out[14] = 1 - tz1; out[15] = 1 - ty1 // left
    out[16] = 1 - tx2; out[17] = 1 - ty2; out[18] = 1 - tx1; out[19] = 1 - ty1 // back
    out[20] = tx1; out[21] = 1 - ty2; out[22] = tx2; out[23] = 1 - ty1 // front
    return out
}

/** rotates all vertices (xyz triples) in place */
function rotateVertices(v: number[], m: Mat3): void {
    for (let o = 0; o < v.length; o += 3) {
        applyMat3(m, v, o)
    }
}

export class MapblockMesher {
    private out = new Map<number, MeshBuffer>()
    private ids!: Uint16Array
    private param1!: Uint8Array
    private param2!: Uint8Array
    private readonly infos: NodeInfo[]

    // the node that is currently meshed
    private info!: NodeInfo
    private index = 0
    /** position inside the mapblock */
    private px = 0
    private py = 0
    private pz = 0
    /** center of the node, relative to the mapblock */
    private ox = 0
    private oy = 0
    private oz = 0
    /** interior light of the node, packed: day | night << 4 */
    private light = 0
    /** position of the mapblock in nodes */
    private blockX = 0
    private blockZ = 0

    // scratch buffers
    private readonly faceTiles = [0, 0, 0, 0, 0, 0]
    private readonly faceRotations = [0, 0, 0, 0, 0, 0]
    private readonly faceLights = [0, 0, 0, 0, 0, 0]
    private readonly txc = new Array<number>(24).fill(0)
    private readonly quadVertices = new Array<number>(12).fill(0)
    private readonly quadUvs = new Array<number>(8).fill(0)

    /** liquid ids resolved per node id: [source, flowing] */
    private readonly liquidIds = new Map<number, [number, number]>()
    private readonly connectCache = new Map<number, boolean>()

    constructor(private readonly nodes: NodeRegistry) {
        this.infos = nodes.infos
    }

    /**
     * @param neighborhood padded node data of the mapblock
     * @param blockOrigin position of the minimum corner of the mapblock in nodes
     * @returns the geometry per tile id
     */
    mesh(neighborhood: Neighborhood, blockOrigin: { x: number, y: number, z: number }): Map<number, MeshBuffer> {
        this.out = new Map()
        this.ids = neighborhood.ids
        this.param1 = neighborhood.param1
        this.param2 = neighborhood.param2
        this.blockX = blockOrigin.x
        this.blockZ = blockOrigin.z

        for (let z = 0; z < 16; z++) {
            for (let y = 0; y < 16; y++) {
                let index = paddedIndex(0, y, z)
                for (let x = 0; x < 16; x++, index++) {
                    const id = this.ids[index]!
                    if (id === CONTENT_IGNORE) {
                        continue
                    }
                    const info = this.infos[id]!
                    if (info.drawtype === "airlike") {
                        continue
                    }
                    this.info = info
                    this.index = index
                    this.px = this.ox = x
                    this.py = this.oy = y
                    this.pz = this.oz = z
                    this.drawNode()
                }
            }
        }
        return this.out
    }

    private drawNode(): void {
        const drawtype = this.info.drawtype
        if (drawtype === "normal") {
            this.drawSolidNode(false)
            return
        }
        if (drawtype === "liquid") {
            this.drawSolidNode(true)
            return
        }
        this.light = this.nodeLight(this.index, this.info)
        switch (drawtype) {
            case "flowingliquid": this.drawFlowingLiquid(); break
            case "glasslike": this.drawGlasslike(); break
            case "glasslike_framed": this.drawGlasslikeFramed(); break
            case "allfaces": this.drawAllfaces(); break
            case "torchlike": this.drawTorchlike(); break
            case "signlike": this.drawSignlike(); break
            case "plantlike": this.drawPlantlike(this.info.tiles[0]!, false); break
            case "plantlike_rooted": this.drawPlantlikeRooted(); break
            case "firelike": this.drawFirelike(); break
            case "fencelike": this.drawFencelike(); break
            case "raillike": this.drawRaillike(); break
            case "nodebox": this.drawNodebox(); break
            case "mesh": this.drawMesh(); break
        }
    }

    // ---- light ----

    /**
     * light of a node from its param1 (packed: day | night << 4), full light where no mapblock is loaded,
     * the day light is never darker than the night light
     */
    private interiorLight(index: number): number {
        const id = this.ids[index]!
        if (id === CONTENT_IGNORE) {
            return 0xff
        }
        const info = this.infos[id]!
        let day = 0, night = 0
        if (info.lightPropagates) {
            const p1 = this.param1[index]!
            day = p1 & 0x0f
            night = p1 >> 4
        }
        night = Math.max(night, info.lightSource)
        return Math.max(day, night) | night << 4
    }

    /** light for nodes that are drawn with a single light value */
    private nodeLight(index: number, info: NodeInfo): number {
        if (info.lightPropagates) {
            return this.interiorLight(index)
        }
        // param1 is not a light value, use the brightest neighbor instead of rendering the node black
        let light = info.lightSource * 0x11
        for (const offset of FACE_OFFSETS) {
            light = maxLight(light, this.interiorLight(index + offset))
        }
        return light
    }

    /** linear vertex color factor at day for a packed light value and a face normal */
    private brightness(light: number, nx: number, ny: number, nz: number): number {
        let b = AMBIENT + (1 - AMBIENT) * LIGHT_CURVE[light & 0x0f]!
        if (this.info.lightSource === 0) {
            b *= faceShade(nx, ny, nz)
        }
        // textures are multiplied in gamma space by the engine
        return Math.pow(b, 2.2)
    }

    // ---- output ----

    private buffer(tile: number): MeshBuffer {
        let buffer = this.out.get(tile)
        if (!buffer) {
            buffer = new MeshBuffer()
            this.out.set(tile, buffer)
        }
        return buffer
    }

    /** adds a quad, the vertices are relative to the center of the current node */
    private quad(tile: number, v: ArrayLike<number>, uv: ArrayLike<number>, brightness: number, light: number): void {
        if (tile < 0) {
            return
        }
        const buffer = this.buffer(tile)
        const base = buffer.positions.length / 3
        const [r, g, b] = this.info.color
        const nightFactor = NIGHT_FACTOR[light]!
        for (let k = 0; k < 4; k++) {
            buffer.positions.push(v[k * 3]! + this.ox, v[k * 3 + 1]! + this.oy, v[k * 3 + 2]! + this.oz)
            buffer.uvs.push(uv[k * 2]!, uv[k * 2 + 1]!)
            buffer.colors.push(brightness * r, brightness * g, brightness * b)
            buffer.nightFactors.push(nightFactor)
        }
        buffer.indices.push(base, base + 1, base + 2, base + 2, base + 3, base)
    }

    /** equivalent of drawQuad: default texture coordinates, optional face shading by a normal */
    private drawQuad(tile: number, v: number[], nx = 0, ny = 0, nz = 0, verticalTiling = 1): void {
        const uv = this.quadUvs
        uv[0] = 0; uv[1] = 0; uv[2] = 1; uv[3] = 0
        uv[4] = 1; uv[5] = verticalTiling; uv[6] = 0; uv[7] = verticalTiling
        this.quad(tile, v, uv, this.brightness(this.light, nx, ny, nz), this.light)
    }

    /**
     * equivalent of drawCuboid
     * @param tiles tile id per face
     * @param rotations tile rotation per face in 90 degree steps
     * @param txc texture coordinates (u1, v1, u2, v2 per face), [0,1] if null
     * @param mask faces whose bit is set are skipped
     * @param lights light per face, the light of the node if null
     */
    private drawCuboid(
        box: ArrayLike<number>, tiles: ArrayLike<number>, rotations: ArrayLike<number> | null,
        txc: ArrayLike<number> | null, mask: number, lights: ArrayLike<number> | null
    ): void {
        const v = this.quadVertices
        const uv = this.quadUvs
        for (let face = 0; face < 6; face++) {
            if (mask & (1 << face)) {
                continue
            }
            const corners = FACE_CORNERS[face]!
            for (let k = 0; k < 12; k++) {
                v[k] = box[corners[k]! * 3 + (k % 3)]!
            }
            const u1 = txc ? txc[face * 4]! : 0, v1 = txc ? txc[face * 4 + 1]! : 0
            const u2 = txc ? txc[face * 4 + 2]! : 1, v2 = txc ? txc[face * 4 + 3]! : 1
            uv[0] = u1; uv[1] = v1; uv[2] = u2; uv[3] = v1
            uv[4] = u2; uv[5] = v2; uv[6] = u1; uv[7] = v2
            const rotation = rotations ? rotations[face]! : 0
            if (rotation !== 0) {
                // see applyTileUV
                for (let k = 0; k < 8; k += 2) {
                    const tu = uv[k]!, tv = uv[k + 1]!
                    if (rotation === 1) {
                        uv[k] = 1 - tv; uv[k + 1] = tu
                    } else if (rotation === 2) {
                        uv[k] = 1 - tu; uv[k + 1] = 1 - tv
                    } else {
                        uv[k] = tv; uv[k + 1] = 1 - tu
                    }
                }
            }
            const n = FACE_NORMALS[face]!
            const light = lights ? lights[face]! : this.light
            this.quad(tiles[face]!, v, uv, this.brightness(light, n[0], n[1], n[2]), light)
        }
    }

    /** equivalent of drawAutoLightedCuboid: applies the visual scale and generates texture coordinates */
    private drawBox(
        box: ArrayLike<number>, tiles: ArrayLike<number>, rotations: ArrayLike<number> | null,
        txc: ArrayLike<number> | null, mask = 0
    ): void {
        const scale = this.info.visualScale
        if (Math.abs(scale - 1) > 1e-3) {
            box = [box[0]! * scale, box[1]! * scale, box[2]! * scale, box[3]! * scale, box[4]! * scale, box[5]! * scale]
        }
        this.drawCuboid(box, tiles, rotations, txc, mask, null)
    }

    // ---- param2 ----

    private getFaceDir(allowWallmounted: boolean): number {
        const param2 = this.param2[this.index]!
        switch (this.info.param2Type) {
            case "facedir":
            case "colorfacedir":
                return (param2 & 0x1f) % 24
            case "4dir":
            case "color4dir":
                return param2 & 0x03
            case "wallmounted":
            case "colorwallmounted":
                return allowWallmounted ? WALLMOUNTED_TO_FACEDIR[Math.min(param2 & 0x07, 7)]! : 0
        }
        return 0
    }

    private getWallMounted(): number {
        const type = this.info.param2Type
        if (type === "wallmounted" || type === "colorwallmounted") {
            return Math.min(this.param2[this.index]! & 0x07, 7)
        }
        switch (this.info.drawtype) {
            case "signlike":
            case "torchlike":
            case "plantlike":
            case "plantlike_rooted":
                return DWM_YN
        }
        return DWM_YP
    }

    private getDegRotate(): number {
        const param2 = this.param2[this.index]!
        if (this.info.param2Type === "degrotate") {
            return param2 % 240
        }
        if (this.info.param2Type === "colordegrotate") {
            return 10 * ((param2 & 0x1f) % 24)
        }
        return 0
    }

    /** selects the tiles of the six faces of the current node, taking its rotation into account (getNodeTile) */
    private selectFaceTiles(): void {
        const table = FACEDIR_TILES[this.getFaceDir(true)]!
        for (let face = 0; face < 6; face++) {
            const entry = table[FACE_DIR_INDEX[face]!]!
            this.faceTiles[face] = this.info.tiles[entry[0]]!
            this.faceRotations[face] = entry[1]
        }
    }

    // ---- solid nodes and liquid sources ----

    private getLiquidIds(info: NodeInfo): [number, number] {
        let ids = this.liquidIds.get(info.id)
        if (!ids) {
            const def = info.def
            let source = this.nodes.lookup(def.liquid_alternative_source)
            let flowing = this.nodes.lookup(def.liquid_alternative_flowing)
            if (source < 0 && flowing < 0) {
                // old exports don't contain the alternatives
                if (info.drawtype === "liquid") {
                    source = info.id
                } else {
                    flowing = info.id
                }
            }
            ids = [source, flowing]
            this.liquidIds.set(info.id, ids)
        }
        return ids
    }

    private drawSolidNode(liquid: boolean): void {
        const info = this.info
        const own = this.ids[this.index]!
        const ownLight = this.interiorLight(this.index)
        let source = -1, flowing = -1
        if (liquid) {
            [source, flowing] = this.getLiquidIds(info)
        }

        let mask = 0
        for (let face = 0; face < 6; face++) {
            const neighborIndex = this.index + FACE_OFFSETS[face]!
            const neighbor = this.ids[neighborIndex]!
            // faces towards missing mapblocks are drawn, they form the border of the scene
            if (neighbor === own
                || (neighbor !== CONTENT_IGNORE && this.infos[neighbor]!.solid)
                || (liquid && (neighbor === source || neighbor === flowing))) {
                mask |= 1 << face
                continue
            }
            this.faceLights[face] = maxLight(ownLight, this.interiorLight(neighborIndex))
        }
        if (mask === 0b111111) {
            return
        }
        this.selectFaceTiles()
        this.drawCuboid(UNIT_BOX, this.faceTiles, this.faceRotations, null, mask, this.faceLights)
    }

    // ---- flowing liquids ----

    private drawFlowingLiquid(): void {
        const info = this.info
        const [source, flowing] = this.getLiquidIds(info)
        const range = flowing >= 0 ? this.infos[flowing]!.liquidRange : info.liquidRange
        const tileTop = info.specialTiles[0]! >= 0 ? info.specialTiles[0]! : info.tiles[0]!
        const tileSide = info.specialTiles[1]! >= 0 ? info.specialTiles[1]! : tileTop
        const isSame = (id: number) => id === source || id === flowing

        const top = this.ids[this.index + DY]!
        const bottom = this.ids[this.index - DY]!
        const topIsSame = isSame(top)
        const drawBottom = !isSame(bottom) && !(bottom !== CONTENT_IGNORE && this.infos[bottom]!.solid)

        // light: emitted light, else the light of the node above if it has any
        let light = this.interiorLight(this.index)
        if (info.lightSource === 0 && top !== CONTENT_IGNORE && this.infos[top]!.lightPropagates) {
            light = this.interiorLight(this.index + DY)
        }
        const brightness = Math.pow(AMBIENT + (1 - AMBIENT) * LIGHT_CURVE[light & 0x0f]!, 2.2)

        // neighborhood [z + 1][x + 1]
        const content: number[] = [], level: number[] = []
        const sameLiquid: boolean[] = [], topSame: boolean[] = []
        for (let w = -1; w <= 1; w++) {
            for (let u = -1; u <= 1; u++) {
                const i = this.index + u * DX + w * DZ
                const id = this.ids[i]!
                let l = -0.5, same = false, above = false
                if (id !== CONTENT_IGNORE) {
                    if (id === source) {
                        same = true
                        l = 0.5
                    } else if (id === flowing) {
                        same = true
                        let liquidLevel = this.param2[i]! & 0x07
                        liquidLevel = liquidLevel <= 8 - range ? 0 : liquidLevel - (8 - range)
                        l = -0.5 + (liquidLevel + 0.5) / range
                    }
                    above = isSame(this.ids[i + DY]!)
                }
                content.push(id); level.push(l); sameLiquid.push(same); topSame.push(above)
            }
        }

        const cornerLevel = (i: number, k: number): number => {
            let sum = 0, count = 0, airCount = 0
            for (let dk = 0; dk < 2; dk++) {
                for (let di = 0; di < 2; di++) {
                    const n = (k + dk) * 3 + i + di
                    if (topSame[n] || content[n] === source) {
                        return 0.5
                    }
                    if (content[n] === flowing) {
                        sum += level[n]!
                        count++
                    } else if (content[n] === this.nodes.airId) {
                        airCount++
                    }
                }
            }
            if (airCount >= 2) {
                return -0.5 + 0.02
            }
            return count > 0 ? sum / count : 0
        }
        // corners[z][x]
        const corners = [[cornerLevel(0, 0), cornerLevel(1, 0)], [cornerLevel(0, 1), cornerLevel(1, 1)]]

        // sides
        const v = this.quadVertices, uv = this.quadUvs
        for (const face of LIQUID_FACES) {
            const n = (face.dz + 1) * 3 + face.dx + 1
            if (sameLiquid[n] && (!topIsSame || topSame[n])) {
                continue
            }
            const neighbor = content[n]!
            if (neighbor !== CONTENT_IGNORE && this.infos[neighbor]!.solid) {
                continue
            }
            for (let j = 0; j < 4; j++) {
                const [vu, vv] = LIQUID_VERTICES[j]!
                const base = face.p[vu]!
                const corner = corners[base[1]]![base[0]]!
                let y: number, tv: number = vv
                if (vv) {
                    y = sameLiquid[n] ? corner : -0.5
                } else if (topIsSame) {
                    y = 0.5
                } else {
                    y = corner
                    tv += 0.5 - corner
                }
                v[j * 3] = base[0] - 0.5; v[j * 3 + 1] = y; v[j * 3 + 2] = base[1] - 0.5
                uv[j * 2] = vu; uv[j * 2 + 1] = tv
            }
            this.quad(tileSide, v, uv, brightness, light)
        }

        if (!topIsSame) {
            v[0] = -0.5; v[1] = corners[1]![0]!; v[2] = 0.5
            v[3] = 0.5; v[4] = corners[1]![1]!; v[5] = 0.5
            v[6] = 0.5; v[7] = corners[0]![1]!; v[8] = -0.5
            v[9] = -0.5; v[10] = corners[0]![0]!; v[11] = -0.5
            uv[0] = 0; uv[1] = 1; uv[2] = 1; uv[3] = 1; uv[4] = 1; uv[5] = 0; uv[6] = 0; uv[7] = 0

            // rotate the texture so that the animation follows the flow direction
            const dz = (corners[0]![0]! + corners[0]![1]!) - (corners[1]![0]! + corners[1]![1]!)
            const dx = (corners[0]![0]! + corners[1]![0]!) - (corners[0]![1]! + corners[1]![1]!)
            const length = Math.hypot(dx, dz)
            const dirX = length > 0 ? dx / length : 1
            const dirY = length > 0 ? dz / length : 0
            const gz = this.blockZ + this.pz, gx = this.blockX + this.px
            let tx = dirX * gz - dirY * gx
            let ty = dirY * gz + dirX * gx
            tx -= Math.floor(tx)
            ty -= Math.floor(ty)
            for (let k = 0; k < 8; k += 2) {
                const cu = uv[k]! - 0.5, cv = uv[k + 1]! - 0.5
                uv[k] = dirX * cu - dirY * cv + 0.5 + tx
                uv[k + 1] = dirY * cu + dirX * cv + 0.5 + ty
            }
            const su = uv[0]!, sv = uv[1]!
            uv[0] = uv[4]!; uv[1] = uv[5]!
            uv[4] = su; uv[5] = sv
            this.quad(tileTop, v, uv, brightness, light)
        }

        if (drawBottom) {
            v[0] = -0.5; v[1] = -0.5; v[2] = -0.5
            v[3] = 0.5; v[4] = -0.5; v[5] = -0.5
            v[6] = 0.5; v[7] = -0.5; v[8] = 0.5
            v[9] = -0.5; v[10] = -0.5; v[11] = 0.5
            this.quad(tileTop, v, DEFAULT_UV, brightness, light)
        }
    }

    // ---- glass ----

    /** a face at z- with half size a and distance g from the center, rotated to the given direction */
    private glassFace(face: number, a: number, g: number): number[] {
        const v = [-a, a, -g, a, a, -g, a, -a, -g, -a, -a, -g]
        switch (face) {
            case D6_ZP: rotateVertices(v, rotationXZ(180)); break
            case D6_YP: rotateVertices(v, rotationYZ(90)); break
            case D6_XP: rotateVertices(v, rotationXZ(90)); break
            case D6_YN: rotateVertices(v, rotationYZ(-90)); break
            case D6_XN: rotateVertices(v, rotationXZ(-90)); break
        }
        return v
    }

    private drawGlasslike(): void {
        const own = this.ids[this.index]!
        for (let face = 0; face < 6; face++) {
            const dir = DIRS_26[face]!
            const neighbor = this.ids[this.index + dir[0] * DX + dir[1] * DY + dir[2] * DZ]!
            if (neighbor === own) {
                continue
            }
            this.drawQuad(this.info.tiles[0]!, this.glassFace(face, 0.5, 0.5), dir[0], dir[1], dir[2])
        }
    }

    private drawGlasslikeFramed(): void {
        const info = this.info
        const own = this.ids[this.index]!
        // tile 0 is the frame, tile 1 the glass
        const frameTile = info.tiles[0]!
        const glassTile = info.tiles[1]!

        // merge bits are only respected for liquid tanks
        const isTank = info.param2Type === "glasslikeliquidlevel"
        let param2 = isTank ? this.param2[this.index]! : 0
        const hMerge = !(param2 & 128)
        const vMerge = !(param2 & 64)
        param2 &= 63

        const nb: boolean[] = new Array(18).fill(false)
        if (hMerge || vMerge) {
            for (let i = 0; i < 18; i++) {
                const dir = DIRS_26[i]!
                if (!hMerge && dir[1] === 0) {
                    continue // vertical-only merge
                }
                if (!vMerge && dir[1] !== 0) {
                    continue // horizontal-only merge
                }
                nb[i] = this.ids[this.index + dir[0] * DX + dir[1] * DY + dir[2] * DZ] === own
            }
        }

        const frameTiles = [frameTile, frameTile, frameTile, frameTile, frameTile, frameTile]
        for (let edge = 0; edge < 12; edge++) {
            const [n1, n2, diagonal] = FRAME_NEIGHBORS[edge]!
            const invisible = nb[diagonal] ? nb[n1] && nb[n2] : nb[n1] !== nb[n2]
            if (invisible) {
                continue
            }
            const box = FRAME_EDGES[edge]!
            this.drawBox(box, frameTiles, null, boxTextureCoords(box, this.txc))
        }

        for (let face = 0; face < 6; face++) {
            if (nb[face]) {
                continue
            }
            const dir = DIRS_26[face]!
            this.drawQuad(glassTile, this.glassFace(face, FRAME_A, FRAME_G), dir[0], dir[1], dir[2])
        }

        // internal liquid level of tanks
        const liquidTile = info.specialTiles[0]!
        if (param2 > 0 && isTank && liquidTile >= 0) {
            const vlev = (param2 / 63) * 2 - 1
            const box: Box = [
                -(nb[D6_XN] ? FRAME_G : FRAME_B),
                -(nb[D6_YN] ? FRAME_G : FRAME_B),
                -(nb[D6_ZN] ? FRAME_G : FRAME_B),
                nb[D6_XP] ? FRAME_G : FRAME_B,
                (nb[D6_YP] ? FRAME_G : FRAME_B) * vlev,
                nb[D6_ZP] ? FRAME_G : FRAME_B
            ]
            const tiles = [liquidTile, liquidTile, liquidTile, liquidTile, liquidTile, liquidTile]
            this.drawBox(box, tiles, null, boxTextureCoords(box, this.txc))
        }
    }

    private drawAllfaces(): void {
        this.drawBox(UNIT_BOX, this.info.tiles, null, null)
    }

    // ---- torches and signs ----

    private drawTorchlike(): void {
        const wall = this.getWallMounted()
        let tileIndex = 2 // side
        if (wall === DWM_YP || wall === DWM_S1) {
            tileIndex = 1 // ceiling
        } else if (wall === DWM_YN || wall === DWM_S2) {
            tileIndex = 0 // floor
        }
        const size = 0.5 * this.info.visualScale
        const v = [-size, size, 0, size, size, 0, size, -size, 0, -size, -size, 0]
        const shift = (axis: number, amount: number) => {
            for (let o = axis; o < 12; o += 3) {
                v[o] = v[o]! + amount
            }
        }
        switch (wall) {
            case DWM_YP: shift(1, -size + 0.5); rotateVertices(v, rotationXZ(-45)); break
            case DWM_YN: shift(1, size - 0.5); rotateVertices(v, rotationXZ(45)); break
            case DWM_XP: shift(0, -size + 0.5); break
            case DWM_XN: shift(0, -size + 0.5); rotateVertices(v, rotationXZ(180)); break
            case DWM_ZP: shift(0, -size + 0.5); rotateVertices(v, rotationXZ(90)); break
            case DWM_ZN: shift(0, -size + 0.5); rotateVertices(v, rotationXZ(-90)); break
            case DWM_S1: shift(1, -size + 0.5); rotateVertices(v, rotationXZ(45)); break
            case DWM_S2: shift(1, size - 0.5); rotateVertices(v, rotationXZ(-45)); break
        }
        this.drawQuad(this.info.tiles[tileIndex]!, v)
    }

    private drawSignlike(): void {
        const wall = this.getWallMounted()
        const offset = 1 / 16
        const size = 0.5 * this.info.visualScale
        // wall at x+ of the node
        const x = 0.5 - offset
        const v = [x, size, size, x, size, -size, x, -size, -size, x, -size, size]
        switch (wall) {
            case DWM_YP: rotateVertices(v, rotationXY(90)); break
            case DWM_YN: rotateVertices(v, rotationXY(-90)); break
            case DWM_XN: rotateVertices(v, rotationXZ(180)); break
            case DWM_ZP: rotateVertices(v, rotationXZ(90)); break
            case DWM_ZN: rotateVertices(v, rotationXZ(-90)); break
            case DWM_S1: rotateVertices(v, multiply(rotationXZ(90), rotationXY(90))); break
            case DWM_S2: rotateVertices(v, multiply(rotationXZ(-90), rotationXY(-90))); break
        }
        this.drawQuad(this.info.tiles[0]!, v)
    }

    // ---- plants ----

    private drawPlantlike(tile: number, rooted: boolean): void {
        const info = this.info
        const param2 = this.param2[this.index]!
        let style = PLANT_STYLE_CROSS
        let scale = 0.5 * info.visualScale
        let rotateDegree = 0
        let randomOffsetY = false
        let plantHeight = 1
        let offsetX = 0, offsetY = 0, offsetZ = 0
        let faceNum = 0

        switch (info.param2Type) {
            case "meshoptions":
                style = param2 & 0x07
                if (param2 & 0x10) {
                    scale *= 1.41421
                }
                if (param2 & 0x08) {
                    const rng = new PseudoRandom(this.px << 8 | this.pz | this.py << 16)
                    offsetX = (rng.next() % 16 / 16) * 0.29 - 0.145
                    offsetZ = (rng.next() % 16 / 16) * 0.29 - 0.145
                }
                randomOffsetY = (param2 & 0x20) !== 0
                break
            case "degrotate":
            case "colordegrotate":
                rotateDegree = 1.5 * this.getDegRotate()
                break
            case "leveled":
                plantHeight = param2 / 16
                break
        }

        const wall = this.getWallMounted()
        if (rooted) {
            switch (wall) {
                case DWM_YP:
                    offsetY += 2
                    break
                case DWM_XN:
                case DWM_XP:
                case DWM_ZN:
                case DWM_ZP:
                    offsetX += -1
                    offsetY += 1
                    break
            }
        }

        let wallRotation: Mat3 | null = null
        switch (wall) {
            case DWM_YP: wallRotation = multiply(rotationXZ(180), rotationYZ(180)); break
            case DWM_XP: wallRotation = rotationXY(90); break
            case DWM_XN: wallRotation = multiply(rotationYZ(180), rotationXY(-90)); break
            case DWM_ZP: wallRotation = multiply(rotationXY(90), rotationYZ(-90)); break
            case DWM_ZN: wallRotation = multiply(rotationXY(90), rotationYZ(90)); break
        }

        const drawQuad = (rotation: number, quadOffset = 0, offsetTopOnly = false) => {
            const top = -0.5 + 2 * scale * plantHeight
            const v = [-scale, top, 0, scale, top, 0, scale, -0.5, 0, -scale, -0.5, 0]
            if (randomOffsetY) {
                const rng = new PseudoRandom(faceNum++ | this.px << 16 | this.pz << 8 | this.py << 24)
                offsetY = -((rng.next() % 16 / 16) * 0.125)
            }
            const offsetCount = offsetTopOnly ? 2 : 4
            for (let i = 0; i < offsetCount; i++) {
                v[i * 3 + 2] = v[i * 3 + 2]! + quadOffset
            }
            rotateVertices(v, rotationXZ(rotation + rotateDegree))
            for (let o = 0; o < 12; o += 3) {
                v[o] = v[o]! + offsetX
                v[o + 1] = v[o + 1]! + offsetY
                v[o + 2] = v[o + 2]! + offsetZ
            }
            if (wallRotation) {
                rotateVertices(v, wallRotation)
            }
            this.drawQuad(tile, v, 0, 0, 0, plantHeight)
        }

        switch (style) {
            case PLANT_STYLE_CROSS2:
                drawQuad(91)
                drawQuad(1)
                break
            case PLANT_STYLE_STAR:
                drawQuad(121)
                drawQuad(241)
                drawQuad(1)
                break
            case PLANT_STYLE_HASH:
                for (const rotation of [1, 91, 181, 271]) {
                    drawQuad(rotation, 0.25)
                }
                break
            case PLANT_STYLE_HASH2:
                for (const rotation of [1, 91, 181, 271]) {
                    drawQuad(rotation, -0.5, true)
                }
                break
            case PLANT_STYLE_CROSS:
            default:
                drawQuad(46)
                drawQuad(-44)
                break
        }
    }

    private drawPlantlikeRooted(): void {
        this.drawSolidNode(false)

        const tile = this.info.specialTiles[0]!
        if (tile < 0) {
            return
        }
        // the plant is drawn in the node above, with the light of that node
        this.light = maxLight(this.interiorLight(this.index + DY), this.info.lightSource * 0x11)
        this.oy += 1
        this.py += 1
        this.drawPlantlike(tile, true)
        this.oy -= 1
        this.py -= 1
    }

    // ---- fire ----

    private drawFirelike(): void {
        const tile = this.info.tiles[0]!
        const own = this.ids[this.index]!
        const scale = 0.5 * this.info.visualScale

        const neighbor: boolean[] = []
        let neighbors = false
        for (let i = 0; i < 6; i++) {
            const dir = DIRS_26[i]!
            const id = this.ids[this.index + dir[0] * DX + dir[1] * DY + dir[2] * DZ]!
            const present = id !== CONTENT_IGNORE && id !== this.nodes.airId && id !== own
            neighbor.push(present)
            neighbors ||= present
        }
        const drawBasicFire = neighbor[D6_YN]! || !neighbors
        const drawBottomFire = neighbor[D6_YP]!

        const drawQuad = (rotation: number, openingAngle: number, offsetH: number, offsetV = 0) => {
            const v = [-scale, -0.5 + scale * 2, 0, scale, -0.5 + scale * 2, 0, scale, -0.5, 0, -scale, -0.5, 0]
            rotateVertices(v, rotationYZ(openingAngle))
            for (let o = 2; o < 12; o += 3) {
                v[o] = v[o]! + offsetH
            }
            rotateVertices(v, rotationXZ(rotation))
            for (let o = 1; o < 12; o += 3) {
                v[o] = v[o]! + offsetV
            }
            this.drawQuad(tile, v)
        }

        const sides = [[D6_ZP, 0], [D6_XN, 90], [D6_ZN, 180], [D6_XP, 270]] as const
        for (const [dir, rotation] of sides) {
            if (drawBasicFire || neighbor[dir]) {
                drawQuad(rotation, -10, 0.4)
            } else if (drawBottomFire) {
                drawQuad(rotation, 70, 0.47, 0.484)
            }
        }
        if (drawBasicFire) {
            drawQuad(45, 0, 0)
            drawQuad(-45, 0, 0)
        }
    }

    // ---- fences ----

    private drawFencelike(): void {
        const tile = this.info.tiles[0]!
        const tiles = [tile, tile, tile, tile, tile, tile]
        // put the wood the right way around in the posts
        this.drawBox(FENCE_POST, tiles, [1, 1, 1, 1, 1, 1], FENCE_POST_UV)

        const isFence = (index: number) => {
            const id = this.ids[index]!
            return id !== CONTENT_IGNORE && this.infos[id]!.drawtype === "fencelike"
        }
        if (isFence(this.index + DX)) {
            this.drawBox(FENCE_BARS_X[0]!, tiles, null, FENCE_BARS_X_UV)
            this.drawBox(FENCE_BARS_X[1]!, tiles, null, FENCE_BARS_X_UV)
        }
        if (isFence(this.index + DZ)) {
            this.drawBox(FENCE_BARS_Z[0]!, tiles, null, FENCE_BARS_Z_UV)
            this.drawBox(FENCE_BARS_Z[1]!, tiles, null, FENCE_BARS_Z_UV)
        }
    }

    // ---- rails ----

    private drawRaillike(): void {
        const info = this.info
        const own = this.ids[this.index]!
        const isSameRail = (dx: number, dy: number, dz: number) => {
            const id = this.ids[this.index + dx * DX + dy * DY + dz * DZ]!
            if (id === own) {
                return true
            }
            if (id === CONTENT_IGNORE) {
                return false
            }
            const other = this.infos[id]!
            return other.drawtype === "raillike" && other.raillikeGroup === info.raillikeGroup
        }

        let code = 0
        let angle = 0
        let sloped = false
        for (let dir = 0; dir < 4; dir++) {
            const [dx, dz] = RAIL_DIRECTIONS[dir]!
            const railAbove = isSameRail(dx, 1, dz)
            if (railAbove) {
                sloped = true
                angle = RAIL_SLOPE_ANGLES[dir]!
            }
            if (railAbove || isSameRail(dx, 0, dz) || isSameRail(dx, -1, dz)) {
                code |= 1 << dir
            }
        }

        let tileIndex: number = RAIL_STRAIGHT
        if (!sloped) {
            [tileIndex, angle] = RAIL_KINDS[code]!
        }

        const offset = 1 / 64
        const size = 0.5
        const y2 = sloped ? size : -size
        const v = [
            -size, y2 + offset, size,
            size, y2 + offset, size,
            size, -size + offset, -size,
            -size, -size + offset, -size
        ]
        if (angle) {
            rotateVertices(v, rotationXZ(angle))
        }
        this.drawQuad(info.tiles[tileIndex]!, v)
    }

    // ---- nodeboxes ----

    /** see NodeDefManager::nodeboxConnects */
    private nodeboxConnects(from: NodeInfo, toId: number): boolean {
        if (toId === CONTENT_IGNORE) {
            return false
        }
        const key = from.id * 65536 + toId
        let result = this.connectCache.get(key)
        if (result === undefined) {
            const to = this.infos[toId]!
            result = connectsTo(from, to)
            if (result && to.nodeBox?.type === "connected") {
                // both sides have to agree
                result = connectsTo(to, from)
            }
            this.connectCache.set(key, result)
        }
        return result
    }

    private collectNodeBoxes(connections: number): Box[] {
        const info = this.info
        const nodeBox = info.nodeBox!
        const boxes: Box[] = []

        switch (nodeBox.type) {
            case "fixed":
            case "leveled": {
                const facedir = this.getFaceDir(true)
                const rotation = facedir !== 0 ? facedirMatrix(facedir) : null
                // getLevel: the level is stored in param2 for leveled nodes
                const level = info.param2Type === "leveled" ? this.param2[this.index]! & 0x7f : 0
                for (const fixed of nodeBox.fixed) {
                    let box: Box = fixed
                    if (nodeBox.type === "leveled" && level > 0) {
                        box = [box[0], box[1], box[2], box[3], -0.5 + level / 64, box[5]]
                    }
                    boxes.push(rotation ? rotateBox(box, rotation) : box)
                }
                break
            }
            case "wallmounted": {
                const wall = this.getWallMounted()
                if (wall === DWM_YP || wall === DWM_S1) {
                    if (nodeBox.wallTop) {
                        boxes.push(wall === DWM_S1 ? rotateBox(nodeBox.wallTop, rotationXZ(90)) : nodeBox.wallTop)
                    }
                } else if (wall === DWM_YN || wall === DWM_S2) {
                    if (nodeBox.wallBottom) {
                        boxes.push(wall === DWM_S2 ? rotateBox(nodeBox.wallBottom, rotationXZ(-90)) : nodeBox.wallBottom)
                    }
                } else if (nodeBox.wallSide) {
                    // the side box is defined for a wall at x-
                    const angle = wall === DWM_XP ? 180 : wall === DWM_ZN ? 90 : wall === DWM_ZP ? -90 : 0
                    boxes.push(angle ? rotateBox(nodeBox.wallSide, rotationXZ(angle)) : nodeBox.wallSide)
                }
                break
            }
            case "connected":
                boxes.push(...nodeBox.fixed)
                for (let dir = 0; dir < 6; dir++) {
                    boxes.push(...(connections & (1 << dir) ? nodeBox.connect[dir]! : nodeBox.disconnected[dir]!))
                }
                if (connections === 0) {
                    boxes.push(...nodeBox.disconnectedAll)
                }
                if (connections < 4) {
                    boxes.push(...nodeBox.disconnectedSides)
                }
                break
            default:
                boxes.push(UNIT_BOX)
        }
        return boxes
    }

    private drawNodebox(): void {
        const info = this.info
        const own = this.ids[this.index]!
        const param2 = this.param2[this.index]!
        const isLevel = info.param2Type === "leveled"

        let connections = 0
        let solidNeighbors = 0
        let sametypeNeighbors = 0
        for (let dir = 0; dir < 6; dir++) {
            const flag = 1 << dir
            const neighborIndex = this.index + FACE_OFFSETS[dir]!
            const neighbor = this.ids[neighborIndex]!
            // same node type with the same rotation or a higher level
            if (neighbor === own
                && (!info.param2IsRotation || param2 === this.param2[neighborIndex])
                && (!isLevel || param2 <= this.param2[neighborIndex]!)) {
                sametypeNeighbors |= flag
            }
            if (neighbor !== CONTENT_IGNORE && this.infos[neighbor]!.solid) {
                solidNeighbors |= flag
            }
            if (info.nodeBox!.type === "connected"
                && this.nodeboxConnects(info, this.ids[this.index + CONNECTION_OFFSETS[dir]!]!)) {
                connections |= flag
            }
        }

        this.selectFaceTiles()
        for (const box of this.collectNodeBoxes(connections)) {
            const mask = nodeBoxMask(box, solidNeighbors, info.alpha === "opaque" ? sametypeNeighbors : 0)
            this.drawBox(box, this.faceTiles, this.faceRotations, boxTextureCoords(box, this.txc), mask)
        }
    }

    // ---- meshes ----

    private drawMesh(): void {
        const info = this.info
        const model = info.model
        if (!model) {
            return
        }

        let rotation: Mat3 | null = null
        switch (info.param2Type) {
            case "facedir":
            case "colorfacedir":
            case "4dir":
            case "color4dir":
            case "wallmounted":
            case "colorwallmounted": {
                const facedir = this.getFaceDir(true)
                if (facedir !== 0) {
                    rotation = facedirMatrix(facedir)
                }
                break
            }
            case "degrotate":
            case "colordegrotate": {
                const degrees = this.getDegRotate()
                if (degrees !== 0) {
                    rotation = rotationXZ(1.5 * degrees)
                }
                break
            }
        }

        const scale = info.visualScale
        const [r, g, b] = info.color
        const position = [0, 0, 0]
        const normal = [0, 0, 0]
        for (let j = 0; j < model.buffers.length; j++) {
            const tile = info.tiles[Math.min(j, 5)]!
            if (tile < 0) {
                continue
            }
            const source = model.buffers[j]!
            const buffer = this.buffer(tile)
            const base = buffer.positions.length / 3
            const count = source.positions.length / 3
            for (let k = 0; k < count; k++) {
                position[0] = source.positions[k * 3]! * scale
                position[1] = source.positions[k * 3 + 1]! * scale
                position[2] = source.positions[k * 3 + 2]! * scale
                normal[0] = source.normals[k * 3]!
                normal[1] = source.normals[k * 3 + 1]!
                normal[2] = source.normals[k * 3 + 2]!
                if (rotation) {
                    applyMat3(rotation, position)
                    applyMat3(rotation, normal)
                }
                buffer.positions.push(position[0]! + this.ox, position[1]! + this.oy, position[2]! + this.oz)
                buffer.uvs.push(source.uvs[k * 2]!, source.uvs[k * 2 + 1]!)
                const brightness = this.brightness(this.light, normal[0]!, normal[1]!, normal[2]!)
                buffer.colors.push(brightness * r, brightness * g, brightness * b)
                buffer.nightFactors.push(NIGHT_FACTOR[this.light]!)
            }
            for (let k = 0; k < source.indices.length; k++) {
                buffer.indices.push(base + source.indices[k]!)
            }
        }
    }
}

/** rotates a box and restores the min/max order */
function rotateBox(box: Box, m: Mat3): Box {
    const v = [box[0], box[1], box[2], box[3], box[4], box[5]]
    applyMat3(m, v, 0)
    applyMat3(m, v, 3)
    return repairBox(v)
}

/** does `from` list `to` (by name or group) in its connects_to */
function connectsTo(from: NodeInfo, to: NodeInfo): boolean {
    const targets = from.def.connects_to
    if (!Array.isArray(targets)) {
        return false
    }
    for (const target of targets) {
        if (target === to.name) {
            return true
        }
        if (target.startsWith("group:")) {
            // multiple groups can be combined: "group:a,b"
            const groups = target.slice(6).split(",")
            if (groups.every(group => (to.def.groups?.[group] ?? 0) !== 0)) {
                return true
            }
        }
    }
    return false
}

/** faces of a nodebox that can be skipped, see getNodeBoxMask */
function nodeBoxMask(box: Box, solidNeighbors: number, sametypeNeighbors: number): number {
    const boundary = 0.5
    // oversized boxes are always drawn completely
    if (box[3] > boundary || box[0] < -boundary || box[4] > boundary
        || box[1] < -boundary || box[5] > boundary || box[2] < -boundary) {
        return 0
    }
    // faces at the node boundary are hidden by solid neighbors
    const solidMask =
        (box[4] === boundary ? 1 : 0) |
        (box[1] === -boundary ? 2 : 0) |
        (box[3] === boundary ? 4 : 0) |
        (box[0] === -boundary ? 8 : 0) |
        (box[5] === boundary ? 16 : 0) |
        (box[2] === -boundary ? 32 : 0)
    // faces on opposite sides cancel each other out between nodes of the same type
    const sametypeMask =
        ((solidMask & 3) === 3 ? 3 : 0) |
        ((solidMask & 12) === 12 ? 12 : 0) |
        ((solidMask & 48) === 48 ? 48 : 0)
    return (solidMask & solidNeighbors) | (sametypeMask & sametypeNeighbors)
}
