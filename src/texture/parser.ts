/**
 * Parser for luanti texture strings like
 * "default_dirt.png^(default_grass_side.png^[colorize:#0f0:80)^[transformR90"
 */

export type TexturePart =
    /** an image file */
    | { type: "file", name: string }
    /** a parenthesized texture string */
    | { type: "group", parts: TexturePart[] }
    /** a texture modifier: "[name:arg1:arg2" or "[transformR90" */
    | { type: "modifier", name: string, args: string }

/** splits at the separator, ignoring escaped separators and (optionally) separators inside of parentheses */
export function splitEscaped(text: string, separator: string, respectParentheses = false): string[] {
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === "\\") {
            i++
        } else if (respectParentheses && c === "(") {
            depth++
        } else if (respectParentheses && c === ")") {
            depth--
        } else if (c === separator && depth <= 0) {
            parts.push(text.slice(start, i))
            start = i + 1
        }
    }
    parts.push(text.slice(start))
    return parts
}

/** removes one level of backslash escapes */
export function unescape(text: string): string {
    return text.replace(/\\(.)/g, "$1")
}

const MODIFIER_NAME = /^\[([a-z]+)/

/** parses a texture string into its parts, they are applied from left to right */
export function parseTexture(texture: string): TexturePart[] {
    const parts: TexturePart[] = []
    for (const raw of splitEscaped(texture, "^", true)) {
        const part = raw.trim()
        if (part === "") {
            continue
        }
        if (part.startsWith("(") && part.endsWith(")")) {
            parts.push({ type: "group", parts: parseTexture(part.slice(1, -1)) })
        } else if (part.startsWith("[")) {
            const name = MODIFIER_NAME.exec(part)?.[1] ?? ""
            // "[transformR90" has no separator between the name and its argument
            if (name.startsWith("transform") && !part.startsWith("[transform:")) {
                parts.push({ type: "modifier", name: "transform", args: part.slice("[transform".length) })
            } else {
                const rest = part.slice(1 + name.length)
                parts.push({ type: "modifier", name, args: rest.startsWith(":") ? rest.slice(1) : rest })
            }
        } else {
            parts.push({ type: "file", name: unescape(part) })
        }
    }
    return parts
}

const TRANSFORM_NAMES = ["i", "r90", "r180", "r270", "fx", "", "fy", ""]

/**
 * parses the argument of "[transform" into one of the 8 transformations:
 * 0 = identity, 1..3 = rotated by 90/180/270 degrees, 4 = flipped x, 5 = flipped x then rotated by 90 degrees,
 * 6 = flipped y, 7 = flipped y then rotated by 90 degrees
 */
export function parseTransform(args: string): number {
    const s = args.toLowerCase()
    let total = 0
    let pos = 0
    while (pos < s.length) {
        let transform = -1
        for (let i = 0; i <= 7; i++) {
            const name = TRANSFORM_NAMES[i]!
            if (s[pos] === String(i)) {
                transform = i
                pos++
                break
            }
            if (name !== "" && s.startsWith(name, pos)) {
                transform = i
                pos += name.length
                break
            }
        }
        if (transform < 0) {
            break
        }
        // multiply in the dihedral group D4
        let combined = transform < 4 ? (transform + total) % 4 : (transform - total + 8) % 4
        if ((transform >= 4) !== (total >= 4)) {
            combined += 4
        }
        total = combined
    }
    return total
}

const NAMED_COLORS: Record<string, string> = {
    white: "ffffff", black: "000000", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00",
    cyan: "00ffff", magenta: "ff00ff", gray: "808080", grey: "808080", orange: "ffa500", purple: "800080",
    brown: "a52a2a", pink: "ffc0cb", lime: "00ff00", silver: "c0c0c0", navy: "000080", maroon: "800000",
    olive: "808000", teal: "008080", aqua: "00ffff", fuchsia: "ff00ff", violet: "ee82ee"
}

/**
 * parses a ColorString: "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA" or a color name with an optional "#AA" suffix
 * @returns [r, g, b, a] (0..255) or null if the string is invalid
 */
export function parseColorString(color: string): [number, number, number, number] | null {
    let hex: string
    const value = color.trim().toLowerCase()
    if (value.startsWith("#")) {
        hex = value.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            hex = [...hex].map(c => c + c).join("")
        }
    } else {
        const [name, alpha] = value.split("#")
        const rgb = NAMED_COLORS[name ?? ""]
        if (!rgb) {
            return null
        }
        hex = rgb + (alpha ?? "")
    }
    if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) {
        return null
    }
    return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
    ]
}
