import { createNodeView, createView, parseMapblock, type MapblockPosition, type NodeDefinition, type ViewerOptions } from "../src"
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
    const scene = params.get("scene")
    const showcase = scene === "showcase"
    document.getElementById(showcase ? "link-showcase" : scene === "node" ? "link-node" : "link-export")!
        .classList.add("active")

    const nodeDefinitions = fetchJson<Record<string, NodeDefinition>>("nodedefs.json")
        .then(defs => new Map(Object.entries(defs)))

    if (scene === "node") {
        return nodeViewer(element, params, await nodeDefinitions)
    }

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
    // optional walking mode with gravity and collision: ?walk
    options.collision = params.has("walk")
    // optional flying through the terrain: ?noclip
    options.noclip = params.has("noclip")
    const viewer = createView(element, options)
    slider.addEventListener("input", () => viewer.setTimeOfDay(slider.valueAsNumber))
}

/**
 * single node with createNodeView: ?scene=node&node=default:chest&param2=0&rotate
 * one view is reused for all nodes with setNodeDefinition
 */
function nodeViewer(element: HTMLElement, params: URLSearchParams, definitions: Map<string, NodeDefinition>) {
    const names = [...definitions.keys()]
        .filter(name => name !== "air" && name !== "ignore" && definitions.get(name)!.drawtype !== "airlike")
        .sort()
    const nameInput = document.getElementById("node-name") as HTMLInputElement
    const param2Input = document.getElementById("node-param2") as HTMLInputElement
    const rotateInput = document.getElementById("node-rotate") as HTMLInputElement
    const slider = document.getElementById("time") as HTMLInputElement
    document.getElementById("node-controls")!.hidden = false
    document.getElementById("node-names")!.append(...names.map(name => new Option("", name)))

    let current = definitions.has(params.get("node") ?? "") ? params.get("node")! : "default:chest"
    nameInput.value = current
    // empty: the default of the view (e.g. wallmounted nodes on the floor)
    param2Input.value = params.get("param2") ?? ""
    rotateInput.checked = params.has("rotate")
    if (params.has("time")) {
        slider.value = params.get("time")!
    }

    const viewer = createNodeView(element, {
        nodedefinition: definitions.get(current)!,
        param2: param2Input.value === "" ? null : param2Input.valueAsNumber,
        getMedia,
        timeOfDay: slider.valueAsNumber,
        autoRotate: rotateInput.checked
    })

    /** shows the node in the inputs (if valid), keeps it in the url to survive a reload */
    const show = (name: string) => {
        const def = definitions.get(name)
        if (!def) {
            return
        }
        current = name
        nameInput.value = name
        const param2 = Number.isNaN(param2Input.valueAsNumber) ? null : Math.min(Math.max(param2Input.valueAsNumber, 0), 255)
        viewer.setNodeDefinition(def, param2)
        const url = new URL(location.href)
        url.searchParams.set("node", name)
        if (param2 === null) {
            url.searchParams.delete("param2")
        } else {
            url.searchParams.set("param2", String(param2))
        }
        history.replaceState(null, "", url)
    }
    const step = (delta: number) => {
        const index = names.indexOf(current)
        show(names[(index + delta + names.length) % names.length]!)
    }

    nameInput.addEventListener("change", () => show(nameInput.value.trim()))
    param2Input.addEventListener("input", () => show(current))
    document.getElementById("node-prev")!.addEventListener("click", () => step(-1))
    document.getElementById("node-next")!.addEventListener("click", () => step(1))
    slider.addEventListener("input", () => viewer.setTimeOfDay(slider.valueAsNumber))
    rotateInput.addEventListener("change", () => {
        viewer.setAutoRotate(rotateInput.checked)
        const url = new URL(location.href)
        if (rotateInput.checked) {
            url.searchParams.set("rotate", "")
        } else {
            url.searchParams.delete("rotate")
        }
        history.replaceState(null, "", url)
    })
}

main().catch(e => {
    console.error(e)
    document.getElementById("view")!.textContent = `failed to start the demo: ${e instanceof Error ? e.message : e}`
    document.getElementById("view")!.style.cssText = "color:#fff;padding:48px 16px"
})
