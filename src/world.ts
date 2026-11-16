import { MAPBLOCK_SIZE, MAPBLOCK_VOLUME, getNodeIndex, type ParsedMapblock } from "./mapblock.js"
import { PADDED_SIZE, type Neighborhood } from "./mesh/mesher.js"
import { CONTENT_IGNORE, type NodeRegistry } from "./mesh/nodes.js"
import type { MapblockPosition } from "./types.js"

type Block = {
    pos: MapblockPosition
    /** internal content ids of the node registry */
    ids: Uint16Array
    param1: Uint8Array
    param2: Uint8Array
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

/** the loaded mapblocks of a scene */
export class World {
    private readonly blocks = new Map<string, Block>()

    constructor(private readonly nodes: NodeRegistry) {}

    get size(): number {
        return this.blocks.size
    }

    /** adds a mapblock, its content ids are translated to the ids of the node registry */
    set(pos: MapblockPosition, mapblock: ParsedMapblock): void {
        const translation = new Map<number, number>()
        for (const [id, name] of mapblock.nodeNames) {
            translation.set(id, this.nodes.getId(name))
        }
        const ids = new Uint16Array(MAPBLOCK_VOLUME)
        for (let i = 0; i < MAPBLOCK_VOLUME; i++) {
            ids[i] = translation.get(mapblock.nodeIds[i]!) ?? CONTENT_IGNORE
        }
        this.blocks.set(key(pos.x, pos.y, pos.z), { pos: { ...pos }, ids, param1: mapblock.param1, param2: mapblock.param2 })
    }

    delete(pos: MapblockPosition): void {
        this.blocks.delete(key(pos.x, pos.y, pos.z))
    }

    has(pos: MapblockPosition): boolean {
        return this.blocks.has(key(pos.x, pos.y, pos.z))
    }

    /**
     * true if the node at the given node position (engine coordinates) blocks the player:
     * walkable nodes and positions without a loaded mapblock (the player waits for them)
     */
    isSolid(x: number, y: number, z: number): boolean {
        const bx = Math.floor(x / MAPBLOCK_SIZE), by = Math.floor(y / MAPBLOCK_SIZE), bz = Math.floor(z / MAPBLOCK_SIZE)
        const block = this.blocks.get(key(bx, by, bz))
        if (!block) {
            return true
        }
        const id = block.ids[getNodeIndex(x - bx * MAPBLOCK_SIZE, y - by * MAPBLOCK_SIZE, z - bz * MAPBLOCK_SIZE)]!
        return id === CONTENT_IGNORE || this.nodes.infos[id]!.walkable
    }

    /** copies the nodes of a mapblock and the adjacent nodes of its 26 neighbors into the padded arrays */
    fillNeighborhood(pos: MapblockPosition, target: Neighborhood): void {
        target.ids.fill(CONTENT_IGNORE)
        target.param1.fill(0)
        target.param2.fill(0)

        // source ranges per axis for the neighbor at offset -1, 0, 1: [first padded coordinate, first local coordinate, count]
        const ranges = [[0, MAPBLOCK_SIZE - 1, 1], [1, 0, MAPBLOCK_SIZE], [PADDED_SIZE - 1, 0, 1]] as const

        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const block = this.blocks.get(key(pos.x + dx, pos.y + dy, pos.z + dz))
                    if (!block) {
                        continue
                    }
                    const [tx, sx, nx] = ranges[dx + 1]!
                    const [ty, sy, ny] = ranges[dy + 1]!
                    const [tz, sz, nz] = ranges[dz + 1]!
                    for (let z = 0; z < nz; z++) {
                        for (let y = 0; y < ny; y++) {
                            const source = ((sz + z) * MAPBLOCK_SIZE + sy + y) * MAPBLOCK_SIZE + sx
                            const dest = ((tz + z) * PADDED_SIZE + ty + y) * PADDED_SIZE + tx
                            if (nx === 1) {
                                target.ids[dest] = block.ids[source]!
                                target.param1[dest] = block.param1[source]!
                                target.param2[dest] = block.param2[source]!
                            } else {
                                target.ids.set(block.ids.subarray(source, source + nx), dest)
                                target.param1.set(block.param1.subarray(source, source + nx), dest)
                                target.param2.set(block.param2.subarray(source, source + nx), dest)
                            }
                        }
                    }
                }
            }
        }
    }
}
