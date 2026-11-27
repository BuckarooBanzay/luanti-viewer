/**
 * Export of a scene as glTF (e.g. for blender): the mapblocks are meshed again and merged into one mesh per tile,
 * the light is either baked into the vertex colors (looks like the viewer) or left out for a renderer with its own
 * lighting.
 */
import {
    BufferAttribute, BufferGeometry, DataTexture, DoubleSide, FrontSide, Group, Mesh, MeshBasicMaterial,
    MeshStandardMaterial, NearestFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, Scene, UnsignedByteType,
    type Camera, type Material, type Texture
} from "three"
import { MAPBLOCK_SIZE } from "./mapblock.js"
import { createNeighborhood, type MapblockMesher, type MeshBuffer } from "./mesh/mesher.js"
import type { TileSpec } from "./mesh/nodes.js"
import type { RgbaImage } from "./texture/compositor.js"
import type { ExportMode, MapblockPosition } from "./types.js"
import type { World } from "./world.js"

/** the main thread is released after this many mapblocks, large exports do not freeze the page */
const YIELD_INTERVAL = 32

/** textures of the tiles, see `MaterialManager` */
export type ExportTiles = {
    getTileSpec(id: number): TileSpec
    getTileImage(id: number): Promise<RgbaImage>
}

export type ExportSceneOptions = {
    mode: ExportMode
    /** daylight share for the baked light (see `timeToDayNightRatio`), ignored in the raw mode */
    dayNightRatio: number
    /** added to the scene (as a copy) if set */
    camera?: Camera | null
}

type Chunk = { buffer: MeshBuffer, origin: MapblockPosition }

/**
 * Meshes the given mapblocks of the world and merges them into one mesh per tile, in three.js coordinates
 * (x is mirrored, like in the view). Mapblocks that are not in the world are skipped.
 */
export async function buildExportScene(
    world: World, positions: Iterable<MapblockPosition>, mesher: MapblockMesher, tiles: ExportTiles,
    options: ExportSceneOptions
): Promise<Scene> {
    const neighborhood = createNeighborhood()
    const chunks = new Map<number, Chunk[]>()
    let count = 0
    for (const pos of positions) {
        if (!world.has(pos)) {
            continue
        }
        world.fillNeighborhood(pos, neighborhood)
        const origin = { x: pos.x * MAPBLOCK_SIZE, y: pos.y * MAPBLOCK_SIZE, z: pos.z * MAPBLOCK_SIZE }
        for (const [tile, buffer] of mesher.mesh(neighborhood, origin)) {
            let list = chunks.get(tile)
            if (!list) {
                list = []
                chunks.set(tile, list)
            }
            list.push({ buffer, origin })
        }
        if (++count % YIELD_INTERVAL === 0) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
    }

    const scene = new Scene()
    scene.name = "luanti"
    const group = new Group()
    group.name = "luanti"
    scene.add(group)

    // tiles that only differ in their alpha mode or backface culling share the texture
    const textures = new Map<string, Promise<Texture>>()
    const textureOf = (tile: number) => {
        const spec = tiles.getTileSpec(tile)
        const key = JSON.stringify([spec.texture, spec.animation ?? null])
        let texture = textures.get(key)
        if (!texture) {
            texture = tiles.getTileImage(tile).then(createExportTexture)
            textures.set(key, texture)
        }
        return texture
    }

    const sorted = [...chunks.entries()].sort(([a], [b]) => a - b)
    const meshes = await Promise.all(sorted.map(async ([tile, list]) => {
        const spec = tiles.getTileSpec(tile)
        const geometry = mergeChunks(list, options)
        const material = createExportMaterial(spec, await textureOf(tile), options.mode,
            geometry.getAttribute("color") !== undefined)
        const mesh = new Mesh(geometry, material)
        mesh.name = material.name
        return mesh
    }))
    for (const mesh of meshes) {
        group.add(mesh)
    }

    if (options.camera) {
        const camera = options.camera.clone()
        camera.name = "Camera"
        scene.add(camera)
    }
    return scene
}

/** gamma space blend of the day and night light, like the shader of the view */
export function bakeLight(nightFactor: number, dayNightRatio: number): number {
    return Math.pow(nightFactor + (1 - nightFactor) * dayNightRatio, 2.2)
}

/** concatenates the buffers of a tile, positions are moved to the mapblock origin and mirrored on x */
function mergeChunks(chunks: Chunk[], options: ExportSceneOptions): BufferGeometry {
    let vertices = 0, indexCount = 0
    for (const { buffer } of chunks) {
        vertices += buffer.vertexCount
        indexCount += buffer.indices.length
    }
    const positions = new Float32Array(vertices * 3)
    const uvs = new Float32Array(vertices * 2)
    const colors = new Float32Array(vertices * 3)
    const indices = vertices > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
    const raw = options.mode === "raw"
    // the raw mode leaves out the vertex colors if all of them are white
    let colored = !raw

    let vertex = 0, index = 0
    for (const { buffer, origin } of chunks) {
        const count = buffer.vertexCount
        for (let i = 0; i < count; i++) {
            const o = (vertex + i) * 3
            positions[o] = -(buffer.positions[i * 3]! + origin.x)
            positions[o + 1] = buffer.positions[i * 3 + 1]! + origin.y
            positions[o + 2] = buffer.positions[i * 3 + 2]! + origin.z
            // v = 0 is the top of the texture in the mesher and in gltf, the texture is not flipped either
            uvs[(vertex + i) * 2] = buffer.uvs[i * 2]!
            uvs[(vertex + i) * 2 + 1] = buffer.uvs[i * 2 + 1]!
            if (raw) {
                for (let c = 0; c < 3; c++) {
                    const value = buffer.baseColors[i * 3 + c]!
                    colors[o + c] = value
                    if (value !== 1) {
                        colored = true
                    }
                }
            } else {
                const light = bakeLight(buffer.nightFactors[i] ?? 1, options.dayNightRatio)
                for (let c = 0; c < 3; c++) {
                    colors[o + c] = buffer.colors[i * 3 + c]! * light
                }
            }
        }
        // mirroring x reverses the winding
        for (let i = 0; i < buffer.indices.length; i += 3) {
            indices[index++] = buffer.indices[i]! + vertex
            indices[index++] = buffer.indices[i + 2]! + vertex
            indices[index++] = buffer.indices[i + 1]! + vertex
        }
        vertex += count
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute("position", new BufferAttribute(positions, 3))
    geometry.setAttribute("uv", new BufferAttribute(uvs, 2))
    if (colored) {
        geometry.setAttribute("color", new BufferAttribute(colors, 3))
    }
    geometry.setIndex(new BufferAttribute(indices, 1))
    if (raw) {
        // lit by the renderer
        geometry.computeVertexNormals()
    }
    geometry.computeBoundingSphere()
    return geometry
}

/** texture with the rows from top to bottom, written as they are by the exporter (gltf: v = 0 is the top) */
function createExportTexture(image: RgbaImage): Texture {
    const texture = new DataTexture(new Uint8Array(image.data), image.width, image.height, RGBAFormat, UnsignedByteType)
    texture.colorSpace = SRGBColorSpace
    texture.magFilter = NearestFilter
    texture.minFilter = NearestFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.flipY = false
    texture.needsUpdate = true
    return texture
}

function createExportMaterial(spec: TileSpec, map: Texture, mode: ExportMode, vertexColors: boolean): Material {
    const params = {
        name: spec.texture,
        map,
        vertexColors,
        side: spec.backfaceCulling ? FrontSide : DoubleSide,
        alphaTest: spec.alpha === "clip" ? 0.5 : 0,
        transparent: spec.alpha === "blend",
        depthWrite: spec.alpha !== "blend"
    }
    // baked: unlit (KHR_materials_unlit), the light is in the vertex colors
    return mode === "raw"
        ? new MeshStandardMaterial({ ...params, roughness: 1, metalness: 0 })
        : new MeshBasicMaterial(params)
}

/** releases the geometries, materials and textures of an export scene */
export function disposeExportScene(scene: Scene): void {
    scene.traverse(object => {
        if (object instanceof Mesh) {
            object.geometry.dispose()
            const material = object.material as MeshBasicMaterial | MeshStandardMaterial
            material.map?.dispose()
            material.dispose()
        }
    })
}

/** writes a scene as glTF, the exporter of three.js is only loaded when needed */
export async function writeGLTF(scene: Scene, binary: boolean): Promise<Blob> {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js")
    const result = await new GLTFExporter().parseAsync(scene, { binary })
    return binary
        ? new Blob([result as ArrayBuffer], { type: "model/gltf-binary" })
        : new Blob([JSON.stringify(result)], { type: "model/gltf+json" })
}
