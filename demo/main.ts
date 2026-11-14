import { createView, parseMapblock, type MapblockPosition, type NodeDefinition, type ViewerOptions } from "../src"
import { createShowcase } from "./showcase"

/** the scene export is served from the root of the dev server (see vite.config.ts) */
const BASE = import.meta.env.BASE_URL

async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(BASE + path)
    if (!response.ok) {
        throw new Error(`could not load ${path}: ${response.status} ${response.statusText}`)
    }
    return response.json()
}

async function getMedia(filename: string): Promise<Blob | null> {
    const response = await fetch(`${BASE}media/${encodeURI(filename)}`)
    return response.ok ? response.blob() : null
}

async function getMapblock(pos: MapblockPosition) {
    // same file name as written by the export mod, e.g. "(0,-1,2).json"
    const response = await fetch(`${BASE}mapblocks/(${pos.x},${pos.y},${pos.z}).json`)
    return response.ok ? parseMapblock(await response.text()) : null
}

async function main() {
    const element = document.getElementById("view")!
    const params = new URLSearchParams(location.search)
    const showcase = params.get("scene") === "showcase"
    document.getElementById(showcase ? "link-showcase" : "link-export")!.classList.add("active")

    const nodeDefinitions = fetchJson<Record<string, NodeDefinition>>("nodedefs.json")
        .then(defs => new Map(Object.entries(defs)))

    let options: ViewerOptions
    if (showcase) {
        // generated scene with one example per drawtype, uses the exported node definitions and media
        const scene = createShowcase()
        options = {
            getNodeDefinitions: async name => scene.nodeDefinitions.get(name) ?? (await nodeDefinitions).get(name) ?? null,
            getMapblock: async pos => scene.getMapblock(pos),
            getMedia,
            minPos: scene.minPos,
            maxPos: scene.maxPos,
            viewRange: 8
        }
    } else {
        const manifest = await fetchJson<{ min: MapblockPosition, max: MapblockPosition }>("mapblocks/manifest.json")
        options = {
            getNodeDefinitions: async name => (await nodeDefinitions).get(name) ?? null,
            getMapblock,
            getMedia,
            minPos: manifest.min,
            maxPos: manifest.max,
            viewRange: 10
        }
    }
    // optional initial camera: ?camera=x,y,z&target=x,y,z (node coordinates)
    const vector = (name: string) => {
        const [x, y, z] = (params.get(name) ?? "").split(",").map(Number)
        return x !== undefined && y !== undefined && z !== undefined && ![x, y, z].some(Number.isNaN) ? { x, y, z } : null
    }
    const position = vector("camera"), target = vector("target")
    if (position && target) {
        options.camera = { position, target }
    }
    // optional view range in mapblocks, loads only the mapblocks around the camera: ?range=4
    const range = Number(params.get("range"))
    if (range > 0) {
        options.viewRange = range
    }
    // optional fps widget: ?fps
    options.showFPS = params.has("fps")
    // optional initial time of day: ?time=0.2 (0 = midnight, 0.5 = noon)
    const slider = document.getElementById("time") as HTMLInputElement
    if (params.has("time")) {
        slider.value = params.get("time")!
    }
    options.timeOfDay = slider.valueAsNumber
    const viewer = createView(element, options)
    slider.addEventListener("input", () => viewer.setTimeOfDay(slider.valueAsNumber))
}

main().catch(e => {
    console.error(e)
    document.getElementById("view")!.textContent = `failed to start the demo: ${e instanceof Error ? e.message : e}`
    document.getElementById("view")!.style.cssText = "color:#fff;padding:48px 16px"
})
