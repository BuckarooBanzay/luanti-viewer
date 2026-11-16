import type { MapblockPosition } from "./types.js"

/** meshes are removed once they are this many mapblocks beyond the view range (avoids thrashing at the border) */
export const UNLOAD_MARGIN = 2
/** the data is kept a bit longer than the meshes: the neighbors of a meshed mapblock are up to sqrt(3) further away */
const DATA_MARGIN = 2

export type Bounds = {
    min: MapblockPosition
    max: MapblockPosition
}

export type LoaderOptions<D, M> = {
    /** radius around the center in mapblocks, Infinity loads everything within the bounds */
    viewRange: number
    /** mapblocks outside of the bounds are never requested, required if the view range is infinite */
    bounds: Bounds | null
    /** parallel fetches */
    concurrency: number
    /** number of unloaded mapblocks whose data is kept for the case that they come back into range, defaults to 0 */
    cacheSize?: number
    /** fetches the data of a mapblock, null if it does not exist */
    fetch(pos: MapblockPosition): Promise<D | null>
    /** makes the fetched data available for meshing, not called if the mapblock left the range in the meantime */
    store(pos: MapblockPosition, data: D): void
    /** releases the stored data */
    unload(pos: MapblockPosition): void
    /** creates the mesh, called once the mapblock and all of its neighbors are stored (or known to be absent) */
    mesh(pos: MapblockPosition): M
    unmesh(mesh: M): void
    /** order of the work, lower values first, defaults to the distance to the center */
    priority?(pos: MapblockPosition, distance: number): number
}

type Entry<D, M> = {
    pos: MapblockPosition
    key: string
    state: "queued" | "fetching" | "loaded" | "absent"
    /** the fetched data, null unless loaded */
    data: D | null
    /** generation of the last range update that needed the data of this mapblock */
    needed: number
    /** within the view range */
    meshWanted: boolean
    meshQueued: boolean
    meshed: boolean
    mesh: M | null
    /** the mesh is outdated and waits in the remesh queue */
    remeshQueued: boolean
    /** an update arrived while the mapblock was fetched, the result of the fetch is outdated */
    superseded: boolean
    priority: number
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`
const nearestLast = (a: { priority: number }, b: { priority: number }) => b.priority - a.priority

/**
 * Keeps the mapblocks around a center loaded and meshed.
 *
 * The mesh of a mapblock depends on the nodes of its 26 neighbors (hidden faces, connected
 * nodes, light), the data is therefore loaded one mapblock further than the meshes and a mesh
 * is only created once all neighbors are resolved. Every mapblock is meshed once and again
 * whenever its data or the data of a neighbor is replaced with `update`.
 */
export class MapblockLoader<D, M> {
    private readonly entries = new Map<string, Entry<D, M>>()
    /** sorted by descending priority value, the next entry is at the end */
    private fetchQueue: Entry<D, M>[] = []
    private meshQueue: Entry<D, M>[] = []
    private meshQueueSorted = true
    /** meshed mapblocks with outdated meshes, processed in order before the mesh queue */
    private remeshQueue: Entry<D, M>[] = []
    private readonly inflight = new Set<Entry<D, M>>()
    /** data of unloaded mapblocks (null: does not exist), least recently unloaded first */
    private readonly cache = new Map<string, D | null>()
    private center: MapblockPosition | null = null
    private generation = 0
    private fetching = 0
    private disposed = false

    constructor(private readonly options: LoaderOptions<D, M>) {
        if (!Number.isFinite(options.viewRange) && !options.bounds) {
            throw new Error("an unlimited view range requires bounds")
        }
    }

    /**
     * Moves the center of the loaded range: requests the mapblocks that came into range and
     * releases the ones that are out of range.
     * @returns false if the center did not change
     */
    setCenter(center: MapblockPosition): boolean {
        const previous = this.center
        if (this.disposed || (previous && previous.x === center.x && previous.y === center.y && previous.z === center.z)) {
            return false
        }
        this.center = { ...center }
        const generation = ++this.generation
        const { viewRange } = this.options

        for (const entry of this.entries.values()) {
            entry.meshWanted = false
        }
        this.forEachInRange((x, y, z) => {
            this.obtain(x, y, z, generation).meshWanted = true
            for (let dz = -1; dz <= 1; dz++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if ((dx || dy || dz) && this.inBounds(x + dx, y + dy, z + dz)) {
                            this.obtain(x + dx, y + dy, z + dz, generation)
                        }
                    }
                }
            }
        })

        this.fetchQueue = []
        this.meshQueue = []
        for (const entry of this.entries.values()) {
            const distance = this.distance(entry.pos)
            if (entry.meshed && distance > viewRange + UNLOAD_MARGIN) {
                this.unmesh(entry)
            }
            if (entry.needed !== generation
                && (entry.state === "queued" || distance > viewRange + UNLOAD_MARGIN + DATA_MARGIN)) {
                // the result of a running fetch only ends up in the cache
                if (entry.state === "loaded") {
                    this.options.unload(entry.pos)
                }
                this.entries.delete(entry.key)
                if (entry.state === "loaded" || entry.state === "absent") {
                    this.addToCache(entry.key, entry.data)
                }
            } else if (entry.state === "queued") {
                this.fetchQueue.push(entry)
            }
        }
        for (const entry of this.entries.values()) {
            entry.meshQueued = false
            this.queueMeshIfReady(entry)
        }
        this.reprioritize()
        this.pump()
        return true
    }

    /**
     * Replaces the data of a mapblock (null: it does not exist anymore) with a newer version from outside,
     * the meshes of the mapblock and of its neighbors are created again. A running fetch of the mapblock
     * is outdated by this, its result is ignored.
     * @returns false if the mapblock is not loaded (out of range), nothing happens besides refreshing the cache
     */
    update(pos: MapblockPosition, data: D | null): boolean {
        if (this.disposed) {
            return false
        }
        const { x, y, z } = pos
        const k = key(x, y, z)
        for (const fetch of this.inflight) {
            if (fetch.key === k) {
                fetch.superseded = true
            }
        }
        const entry = this.entries.get(k)
        if (!entry) {
            if (this.cache.has(k)) {
                this.cache.set(k, data)
            }
            return false
        }
        if (entry.state === "loaded" && data === null) {
            this.options.unload(entry.pos)
            entry.data = null
        }
        this.resolve(entry, data)
        if (data === null && entry.meshed) {
            this.unmesh(entry)
        }
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const candidate = this.entries.get(key(x + dx, y + dy, z + dz))
                    if (!candidate) {
                        continue
                    }
                    if (!candidate.meshed) {
                        // a missing or pending mapblock got its data
                        this.queueMeshIfReady(candidate)
                    } else if (!candidate.remeshQueued) {
                        candidate.remeshQueued = true
                        this.remeshQueue.push(candidate)
                    }
                }
            }
        }
        return true
    }

    /** re-evaluates the priority of the pending work, e.g. after the camera was rotated */
    reprioritize(): void {
        for (const entry of this.fetchQueue) {
            entry.priority = this.priorityOf(entry)
        }
        for (const entry of this.meshQueue) {
            entry.priority = this.priorityOf(entry)
        }
        this.fetchQueue.sort(nearestLast)
        this.meshQueue.sort(nearestLast)
        this.meshQueueSorted = true
    }

    /** creates pending meshes (at least one) for as long as `proceed` returns true, outdated meshes are replaced first */
    processMeshes(proceed: () => boolean): void {
        if (!this.meshQueueSorted) {
            this.meshQueue.sort(nearestLast)
            this.meshQueueSorted = true
        }
        do {
            const outdated = this.remeshQueue.shift()
            if (outdated) {
                outdated.remeshQueued = false
                // unloaded in the meantime otherwise
                if (outdated.meshed) {
                    this.options.unmesh(outdated.mesh as M)
                    outdated.mesh = this.options.mesh(outdated.pos)
                }
                continue
            }
            const entry = this.meshQueue.pop()
            if (!entry) {
                return
            }
            entry.meshQueued = false
            // removed by an update otherwise
            if (entry.state === "loaded") {
                entry.meshed = true
                entry.mesh = this.options.mesh(entry.pos)
            }
        } while (proceed())
    }

    /** number of mapblocks that are not fetched / not meshed yet */
    stats(): { fetching: number, meshing: number } {
        let fetching = 0, meshing = 0
        for (const entry of this.entries.values()) {
            if (entry.state === "queued" || entry.state === "fetching") {
                fetching++
            }
            if (entry.meshWanted && !entry.meshed && entry.state !== "absent") {
                meshing++
            }
        }
        return { fetching, meshing }
    }

    /** removes all meshes, running fetches are ignored */
    dispose(): void {
        this.disposed = true
        for (const entry of this.entries.values()) {
            if (entry.meshed) {
                this.unmesh(entry)
            }
        }
        this.entries.clear()
        this.cache.clear()
        this.fetchQueue = []
        this.meshQueue = []
        this.remeshQueue = []
    }

    private inBounds(x: number, y: number, z: number): boolean {
        const bounds = this.options.bounds
        return !bounds || (x >= bounds.min.x && x <= bounds.max.x
            && y >= bounds.min.y && y <= bounds.max.y
            && z >= bounds.min.z && z <= bounds.max.z)
    }

    private distance(pos: MapblockPosition): number {
        const center = this.center!
        return Math.hypot(pos.x - center.x, pos.y - center.y, pos.z - center.z)
    }

    private priorityOf(entry: Entry<D, M>): number {
        const distance = this.distance(entry.pos)
        return this.options.priority ? this.options.priority(entry.pos, distance) : distance
    }

    /** calls back for every mapblock within the view range and the bounds */
    private forEachInRange(callback: (x: number, y: number, z: number) => void): void {
        const { viewRange, bounds } = this.options
        const center = this.center!
        const finite = Number.isFinite(viewRange)
        const range = (axis: "x" | "y" | "z"): [number, number] => [
            Math.max(finite ? Math.ceil(center[axis] - viewRange) : -Infinity, bounds?.min[axis] ?? -Infinity),
            Math.min(finite ? Math.floor(center[axis] + viewRange) : Infinity, bounds?.max[axis] ?? Infinity)
        ]
        const [minX, maxX] = range("x"), [minY, maxY] = range("y"), [minZ, maxZ] = range("z")
        for (let z = minZ; z <= maxZ; z++) {
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    if (!finite || Math.hypot(x - center.x, y - center.y, z - center.z) <= viewRange) {
                        callback(x, y, z)
                    }
                }
            }
        }
    }

    private obtain(x: number, y: number, z: number, generation: number): Entry<D, M> {
        const k = key(x, y, z)
        let entry = this.entries.get(k)
        if (!entry) {
            entry = {
                pos: { x, y, z }, key: k, state: "queued", data: null, needed: generation,
                meshWanted: false, meshQueued: false, meshed: false, mesh: null,
                remeshQueued: false, superseded: false, priority: 0
            }
            this.entries.set(k, entry)
            const cached = this.cache.get(k)
            if (cached !== undefined) {
                this.cache.delete(k)
                this.resolve(entry, cached)
            }
        }
        entry.needed = generation
        return entry
    }

    private unmesh(entry: Entry<D, M>): void {
        this.options.unmesh(entry.mesh as M)
        entry.mesh = null
        entry.meshed = false
    }

    /** starts fetches until the concurrency limit is reached */
    private pump(): void {
        while (this.fetching < this.options.concurrency) {
            const entry = this.fetchQueue.pop()
            if (!entry) {
                return
            }
            // resolved by an update otherwise
            if (entry.state === "queued") {
                this.start(entry)
            }
        }
    }

    private start(entry: Entry<D, M>): void {
        entry.state = "fetching"
        this.fetching++
        this.inflight.add(entry)
        const { x, y, z } = entry.pos
        this.options.fetch(entry.pos).catch(e => {
            console.error(`[luanti-viewer] failed to load mapblock (${x},${y},${z})`, e)
            return null
        }).then(data => {
            this.fetching--
            this.inflight.delete(entry)
            if (this.disposed) {
                return
            }
            if (entry.superseded) {
                // an update delivered newer data
            } else if (this.entries.get(entry.key) === entry) {
                // unchanged entry: the mapblock did not leave the range while it was fetched
                this.resolve(entry, data)
                // this mapblock and its neighbors might be ready for meshing now
                for (let dz = -1; dz <= 1; dz++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const candidate = this.entries.get(key(x + dx, y + dy, z + dz))
                            if (candidate) {
                                this.queueMeshIfReady(candidate)
                            }
                        }
                    }
                }
            } else {
                this.addToCache(entry.key, data)
            }
            this.pump()
        })
    }

    private resolve(entry: Entry<D, M>, data: D | null): void {
        if (data !== null) {
            this.options.store(entry.pos, data)
            entry.data = data
            entry.state = "loaded"
        } else {
            entry.state = "absent"
        }
    }

    private addToCache(k: string, data: D | null): void {
        const size = this.options.cacheSize ?? 0
        // a newer entry of the same mapblock is responsible for it
        if (size <= 0 || this.entries.has(k)) {
            return
        }
        this.cache.delete(k)
        this.cache.set(k, data)
        if (this.cache.size > size) {
            this.cache.delete(this.cache.keys().next().value!)
        }
    }

    private queueMeshIfReady(entry: Entry<D, M>): void {
        if (!entry.meshWanted || entry.meshed || entry.meshQueued || entry.state !== "loaded") {
            return
        }
        const { x, y, z } = entry.pos
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!this.inBounds(x + dx, y + dy, z + dz)) {
                        continue
                    }
                    const neighbor = this.entries.get(key(x + dx, y + dy, z + dz))
                    if (!neighbor || neighbor.state === "queued" || neighbor.state === "fetching") {
                        return
                    }
                }
            }
        }
        entry.meshQueued = true
        entry.priority = this.priorityOf(entry)
        this.meshQueue.push(entry)
        this.meshQueueSorted = false
    }
}
