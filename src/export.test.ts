import { crc32, deflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, type DataTexture, type Scene } from "three"
import { bakeLight, buildExportScene, writeGLTF, type ExportTiles } from "./export.js"
import { MAPBLOCK_VOLUME, ParsedMapblock, getNodeIndex } from "./mapblock.js"
import { LIGHT_CURVE, MapblockMesher } from "./mesh/mesher.js"
import { NodeRegistry, type TileSpec } from "./mesh/nodes.js"
import { createImage, type RgbaImage } from "./texture/compositor.js"
import type { NodeDefinition } from "./types.js"
import { World } from "./world.js"

const base = { paramtype: "none", paramtype2: "none", light_source: 0, groups: null } as const
const definitions: NodeDefinition[] = [
    { ...base, paramtype: "light", name: "air", drawtype: "airlike" },
    { ...base, name: "stone", drawtype: "normal", tiles: ["stone.png"] },
    { ...base, name: "red", drawtype: "normal", tiles: ["stone.png"], color: "#ff0000" },
    { ...base, name: "lamp", drawtype: "normal", tiles: ["stone.png"], light_source: 14 },
    { ...base, paramtype: "light", name: "water", drawtype: "liquid", tiles: ["water.png"], use_texture_alpha: "blend" }
]

/** a 1x2 texture: red on top, blue at the bottom */
function texture(): RgbaImage {
    const image = createImage(1, 2)
    image.data.set([255, 0, 0, 255, 0, 0, 255, 255])
    return image
}

async function setup() {
    const specs: TileSpec[] = []
    const keys = new Map<string, number>()
    const nodes = new NodeRegistry(async name => definitions.find(def => def.name === name) ?? null, {
        getTile(spec) {
            const key = JSON.stringify(spec)
            if (!keys.has(key)) {
                keys.set(key, specs.push(spec) - 1)
            }
            return keys.get(key)!
        }
    })
    await nodes.ensure(definitions.map(def => def.name))
    const tiles: ExportTiles = { getTileSpec: id => specs[id]!, getTileImage: async () => texture() }

    /** mapblock of air (day light 15, night light 0) with the given nodes */
    const block = (contents: [x: number, y: number, z: number, name: string][]) => {
        const names = ["air", ...new Set(contents.map(c => c[3]))]
        const ids = new Uint16Array(MAPBLOCK_VOLUME)
        for (const [x, y, z, name] of contents) {
            ids[getNodeIndex(x, y, z)] = names.indexOf(name)
        }
        return new ParsedMapblock(ids, new Uint8Array(MAPBLOCK_VOLUME).fill(0x0f), new Uint8Array(MAPBLOCK_VOLUME),
            new Map(names.map((name, i) => [i, name])))
    }
    const world = new World(nodes)
    world.set({ x: 0, y: 0, z: 0 }, block([[0, 0, 0, "stone"], [5, 0, 0, "red"], [9, 9, 9, "water"], [12, 0, 0, "lamp"]]))
    world.set({ x: 1, y: 0, z: 0 }, block([[0, 0, 0, "stone"]]))
    const positions = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 5, y: 5, z: 5 }]
    const build = (mode: "baked" | "raw", dayNightRatio = 1, camera: PerspectiveCamera | null = null, emissiveStrength?: number) =>
        buildExportScene(world, positions, new MapblockMesher(nodes), tiles, { mode, dayNightRatio, camera, emissiveStrength })
    return { nodes, world, build }
}

const meshes = (scene: Scene) => {
    const result: Mesh[] = []
    scene.traverse(o => o instanceof Mesh && result.push(o))
    return result
}
const byName = (scene: Scene, name: string) => meshes(scene).filter(m => m.name === name)

describe("buildExportScene", () => {
    it("merges the mapblocks into one mesh per tile in three.js coordinates", async () => {
        const { build } = await setup()
        const scene = await build("raw")
        // stone and red share the texture but not the color: same tile, merged, the lamp has its own (emissive) mesh
        expect(meshes(scene).map(m => m.name).sort()).toEqual(["stone.png", "stone.png (light 14)", "water.png"])
        const [stone] = byName(scene, "stone.png")
        const position = stone!.geometry.getAttribute("position")
        // three cubes with 6 faces of 4 vertices
        expect(position.count).toBe(3 * 24)
        const xs = Array.from({ length: position.count }, (_, i) => position.getX(i))
        // the stone at node x = 16 of the second mapblock, mirrored
        expect(Math.min(...xs)).toBe(-16.5)
        expect(Math.max(...xs)).toBe(0.5)

        // the winding is reversed with the mirroring: the normals point out of the nodes
        const normal = stone!.geometry.getAttribute("normal")
        const centers = new Set(["0,0,0", "-5,0,0", "-16,0,0"])
        for (let quad = 0; quad < position.count; quad += 4) {
            const center = [0, 0, 0]
            for (let i = quad; i < quad + 4; i++) {
                center[0]! += position.getX(i) / 4
                center[1]! += position.getY(i) / 4
                center[2]! += position.getZ(i) / 4
            }
            const node = [center[0]! - normal.getX(quad) / 2, center[1]! - normal.getY(quad) / 2, center[2]! - normal.getZ(quad) / 2]
            expect(centers).toContain(node.map(v => Math.round(v) + 0).join(","))
        }
    })

    it("bakes the light of the time of day into the vertex colors", async () => {
        const { build } = await setup()
        const day = byName(await build("baked", 1), "stone.png")[0]!
        const night = byName(await build("baked", 0.175), "stone.png")[0]!
        expect(day.material).toBeInstanceOf(MeshBasicMaterial)
        expect(day.geometry.getAttribute("normal")).toBeUndefined()
        const dayColor = day.geometry.getAttribute("color"), nightColor = night.geometry.getAttribute("color")
        // only daylight, no artificial light: dimmed at night,
        // except for the faces next to unloaded mapblocks (they are fully lit)
        let dimmed = 0
        for (let i = 0; i < dayColor.count; i++) {
            expect(dayColor.getX(i)).toBeGreaterThan(0)
            expect(nightColor.getX(i)).toBeLessThanOrEqual(dayColor.getX(i))
            dimmed += nightColor.getX(i) < dayColor.getX(i) ? 1 : 0
        }
        expect(dimmed).toBeGreaterThan(dayColor.count / 2)
        expect(bakeLight(0, 1)).toBe(1)
        expect(bakeLight(1, 0)).toBe(1)
        expect(bakeLight(0, 0)).toBe(0)
    })

    it("leaves the light out in the raw mode", async () => {
        const { build } = await setup()
        const scene = await build("raw")
        const [stone] = byName(scene, "stone.png")
        const [water] = byName(scene, "water.png")
        expect(stone!.material).toBeInstanceOf(MeshStandardMaterial)
        // the colors of the nodes without the light: white stone and the red node
        const color = stone!.geometry.getAttribute("color")
        const colors = new Set(Array.from({ length: color.count }, (_, i) => `${color.getX(i)},${color.getY(i)},${color.getZ(i)}`))
        expect([...colors].sort()).toEqual(["1,0,0", "1,1,1"])
        // all white: no vertex colors at all
        expect(water!.geometry.getAttribute("color")).toBeUndefined()
        expect((water!.material as MeshStandardMaterial).vertexColors).toBe(false)
    })

    it("makes light sources emissive in the raw mode", async () => {
        const { build } = await setup()
        const scene = await build("raw", 1, null, 5)
        const stone = byName(scene, "stone.png")[0]!.material as MeshStandardMaterial
        const lamp = byName(scene, "stone.png (light 14)")[0]!
        const material = lamp.material as MeshStandardMaterial
        expect(lamp.geometry.getAttribute("position").count).toBe(24)
        // the lamp is at node x = 12, mirrored
        expect(lamp.geometry.boundingSphere!.center.x).toBeCloseTo(-12)
        expect(material.emissiveMap).toBe(material.map)
        expect(material.emissive.r).toBeCloseTo(Math.pow(LIGHT_CURVE[14]!, 2.2))
        expect(material.emissiveIntensity).toBe(5)
        expect(stone.emissive.getHex()).toBe(0)
        expect(stone.emissiveMap).toBeNull()

        // the baked mode does not split the lamp off
        const baked = await build("baked")
        expect(byName(baked, "stone.png (light 14)")).toHaveLength(0)
        expect(byName(baked, "stone.png")[0]!.geometry.getAttribute("position").count).toBe(4 * 24)
    })

    it("keeps the alpha mode, backface culling and texture orientation", async () => {
        const { build } = await setup()
        const scene = await build("baked")
        const water = byName(scene, "water.png")[0]!.material as MeshBasicMaterial
        expect(water.transparent).toBe(true)
        expect(water.depthWrite).toBe(false)
        const stone = byName(scene, "stone.png")[0]!.material as MeshBasicMaterial
        expect(stone.transparent).toBe(false)
        // rows from top to bottom, not flipped: v = 0 is the top in the mesher and in gltf
        const map = stone.map as DataTexture
        expect(map.flipY).toBe(false)
        expect([...map.image.data!.slice(0, 4)]).toEqual([255, 0, 0, 255])
        // shared by both tiles with the same texture string only
        expect(map).not.toBe((water.map as DataTexture))
    })

    it("adds a copy of the camera", async () => {
        const { build } = await setup()
        const camera = new PerspectiveCamera()
        camera.position.set(1, 2, 3)
        const scene = await build("baked", 1, camera)
        const exported = scene.getObjectByName("Camera") as PerspectiveCamera
        expect(exported).not.toBe(camera)
        expect(exported.position.toArray()).toEqual([1, 2, 3])
        expect((await build("baked")).getObjectByName("Camera")).toBeUndefined()
    })
})

/** minimal png encoder for the canvas polyfill */
function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
    const chunk = (type: string, data: Uint8Array) => {
        const out = Buffer.alloc(12 + data.length)
        out.writeUInt32BE(data.length, 0)
        out.write(type, 4, "latin1")
        out.set(data, 8)
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
        return out
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header.set([8, 6, 0, 0, 0], 8)
    const raw = Buffer.alloc((width * 4 + 1) * height)
    for (let y = 0; y < height; y++) {
        raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())])
}

/** the parts of OffscreenCanvas, ImageData and FileReader the exporter of three.js uses, missing in node */
const polyfills: Record<string, unknown> = {
    ImageData: class {
        constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    },
    OffscreenCanvas: class {
        image: { data: Uint8ClampedArray } | null = null
        constructor(public width: number, public height: number) {}
        getContext() {
            return { translate() {}, scale() {}, putImageData: (image: { data: Uint8ClampedArray }) => this.image = image }
        }
        async convertToBlob() {
            return new Blob([encodePng(this.width, this.height, this.image!.data) as Uint8Array<ArrayBuffer>], { type: "image/png" })
        }
    },
    FileReader: class {
        result: ArrayBuffer | null = null
        onloadend: (() => void) | null = null
        readAsArrayBuffer(blob: Blob) {
            blob.arrayBuffer().then(buffer => {
                this.result = buffer
                this.onloadend?.()
            })
        }
    }
}

describe("writeGLTF", () => {
    beforeAll(() => {
        for (const [name, value] of Object.entries(polyfills)) {
            (globalThis as Record<string, unknown>)[name] = value
        }
    })
    afterAll(() => {
        for (const name of Object.keys(polyfills)) {
            delete (globalThis as Record<string, unknown>)[name]
        }
    })

    /** splits a glb into its json and binary chunk */
    const parseGlb = async (blob: Blob) => {
        const buffer = await blob.arrayBuffer()
        const view = new DataView(buffer)
        expect(view.getUint32(0, true)).toBe(0x46546c67)
        const jsonLength = view.getUint32(12, true)
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)))
        return { json, bin: new Uint8Array(buffer, 28 + jsonLength) }
    }

    it("writes the baked scene as glb with unlit materials, vertex colors, textures and the camera", async () => {
        const { build } = await setup()
        const blob = await writeGLTF(await build("baked", 1, new PerspectiveCamera()), true)
        expect(blob.type).toBe("model/gltf-binary")
        const { json, bin } = await parseGlb(blob)

        expect(json.extensionsUsed).toContain("KHR_materials_unlit")
        const water = json.materials.find((m: { name: string }) => m.name === "water.png")
        expect(water.alphaMode).toBe("BLEND")
        const stone = json.materials.find((m: { name: string }) => m.name === "stone.png")
        expect(stone.alphaMode).toBeUndefined()
        expect(stone.doubleSided).toBeUndefined()
        expect(json.meshes.every((m: { primitives: { attributes: object }[] }) => "COLOR_0" in m.primitives[0]!.attributes)).toBe(true)
        // pixelated textures
        expect(json.samplers[0]).toMatchObject({ magFilter: 9728, minFilter: 9728 })
        expect(json.cameras).toHaveLength(1)

        // embedded png, red on top (not flipped)
        const image = json.images[0]
        expect(image.mimeType).toBe("image/png")
        const bufferView = json.bufferViews[image.bufferView]
        const png = bin.subarray(bufferView.byteOffset ?? 0, (bufferView.byteOffset ?? 0) + bufferView.byteLength)
        expect([...png.subarray(1, 4)]).toEqual([80, 78, 71])
    })

    it("writes lit materials and normals in the raw mode", async () => {
        const { build } = await setup()
        const { json } = await parseGlb(await writeGLTF(await build("raw", 1, null, 5), true))
        expect(json.extensionsUsed ?? []).not.toContain("KHR_materials_unlit")
        const lamp = json.materials.find((m: { name: string }) => m.name === "stone.png (light 14)")
        const stone = json.materials.find((m: { name: string }) => m.name === "stone.png")
        expect(lamp.emissiveTexture.index).toBe(lamp.pbrMetallicRoughness.baseColorTexture.index)
        expect(lamp.emissiveFactor[0]).toBeCloseTo(Math.pow(LIGHT_CURVE[14]!, 2.2))
        expect(lamp.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(5)
        expect(stone.emissiveFactor).toBeUndefined()
        expect(json.materials[0].pbrMetallicRoughness).toMatchObject({ metallicFactor: 0, roughnessFactor: 1 })
        expect(json.meshes.every((m: { primitives: { attributes: object }[] }) => "NORMAL" in m.primitives[0]!.attributes)).toBe(true)
        expect(json.cameras).toBeUndefined()
    })
})
