/** radius of the virtual joystick in css pixels */
export const STICK_RADIUS = 50
/** share of the joystick radius without any movement */
const DEAD_ZONE = 0.15
/** radians per css pixel of a look drag */
const LOOK_SPEED = 0.005
/** the camera does not flip over at the poles */
const MAX_PITCH = Math.PI / 2 - 0.01

/**
 * movement (each axis -1..1, length 0..1) for a joystick knob dragged by dx/dy pixels from its center,
 * dragging up moves forward, the strength rises from 0 at the edge of the dead zone to 1 at the radius
 */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): { forward: number, right: number } {
    const distance = Math.hypot(dx, dy)
    const length = distance / radius
    if (length < DEAD_ZONE) {
        return { forward: 0, right: 0 }
    }
    const scale = (Math.min(length, 1) - DEAD_ZONE) / (1 - DEAD_ZONE) / distance
    return { forward: -dy * scale || 0, right: dx * scale || 0 }
}

/** yaw and pitch (radians) after a look drag by dx/dy pixels, dragging right turns right, dragging down looks down */
export function applyLook(yaw: number, pitch: number, dx: number, dy: number): { yaw: number, pitch: number } {
    return {
        yaw: yaw - dx * LOOK_SPEED,
        pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch - dy * LOOK_SPEED))
    }
}

export type TouchInput = {
    /** -1..1 */
    forward: number
    /** -1..1 */
    right: number
    /** -1 (down), 0 or 1 (up / jump) */
    up: number
    fast: boolean
}

export type TouchHandlers = {
    /** a finger was dragged over the view by dx/dy pixels */
    look(dx: number, dy: number): void
    /** the walk/fly button was tapped */
    toggleWalking(): void
    /** the noclip button was tapped */
    toggleNoclip(): void
    /** the controls were closed by the user */
    deactivated(): void
}

export type TouchControls = {
    /** current movement input, all zero while the controls are not active */
    readonly input: Readonly<TouchInput>
    /** shows the controls and captures all touches on the view */
    activate(): void
    /** hides the controls, the page scrolls again with touches on the view */
    deactivate(): void
    /** reflects the current mode in the buttons */
    setWalking(walking: boolean): void
    /** reflects the noclip setting of the flying camera in its button */
    setNoclip(noclip: boolean): void
}

const BUTTON_STYLE = "position:absolute;width:52px;height:52px;padding:0;border-radius:50%;box-sizing:border-box;"
    + "border:2px solid rgba(255,255,255,.5);color:#fff;font:600 13px/1 system-ui,sans-serif;touch-action:none;"
    + "user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;"
const BUTTON_BACKGROUND = "rgba(0,0,0,.4)"
const BUTTON_ACTIVE_BACKGROUND = "rgba(255,255,255,.4)"

/**
 * On-screen controls for touch devices, hidden until they are activated:
 * the left half of the view is a joystick that appears below the finger, a drag anywhere else looks around
 * and buttons move up/down (jump while walking), toggle the fast mode, noclip and the walking mode and close the controls.
 */
export function createTouchControls(container: HTMLElement, handlers: TouchHandlers): TouchControls {
    const input: TouchInput = { forward: 0, right: 0, up: 0, fast: false }

    // covers the view while active: receives all touches and keeps the page from scrolling
    const layer = document.createElement("div")
    layer.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:none;touch-action:none;"
        + "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent"
    layer.addEventListener("contextmenu", e => e.preventDefault())
    container.appendChild(layer)

    const base = document.createElement("div")
    base.style.cssText = `position:absolute;width:${STICK_RADIUS * 2}px;height:${STICK_RADIUS * 2}px;`
        + `margin:-${STICK_RADIUS}px 0 0 -${STICK_RADIUS}px;border-radius:50%;box-sizing:border-box;`
        + "border:2px solid rgba(255,255,255,.5);background:rgba(0,0,0,.25);display:none;pointer-events:none"
    const knob = document.createElement("div")
    knob.style.cssText = "position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;"
        + "border-radius:50%;background:rgba(255,255,255,.6)"
    base.appendChild(knob)
    layer.appendChild(base)

    // one finger on the joystick, one to look around
    let stickId: number | null = null, stickX = 0, stickY = 0
    let lookId: number | null = null, lookX = 0, lookY = 0
    const releaseStick = () => {
        stickId = null
        input.forward = 0
        input.right = 0
        base.style.display = "none"
    }
    const capture = (target: HTMLElement, e: PointerEvent) => {
        try {
            target.setPointerCapture(e.pointerId)
        } catch {
            // the pointer is already gone
        }
        e.preventDefault()
    }
    layer.addEventListener("pointerdown", e => {
        const rect = layer.getBoundingClientRect()
        const x = e.clientX - rect.left
        if (stickId === null && x < rect.width / 2) {
            stickId = e.pointerId
            stickX = e.clientX
            stickY = e.clientY
            base.style.left = `${x}px`
            base.style.top = `${e.clientY - rect.top}px`
            base.style.display = "block"
            knob.style.transform = ""
        } else if (lookId === null) {
            lookId = e.pointerId
            lookX = e.clientX
            lookY = e.clientY
        } else {
            return
        }
        capture(layer, e)
    })
    layer.addEventListener("pointermove", e => {
        if (e.pointerId === stickId) {
            const dx = e.clientX - stickX, dy = e.clientY - stickY
            // the knob stays within the base
            const scale = Math.min(1, STICK_RADIUS / Math.max(Math.hypot(dx, dy), 1e-6))
            knob.style.transform = `translate(${dx * scale}px,${dy * scale}px)`
            const vector = stickVector(dx, dy)
            input.forward = vector.forward
            input.right = vector.right
        } else if (e.pointerId === lookId) {
            handlers.look(e.clientX - lookX, e.clientY - lookY)
            lookX = e.clientX
            lookY = e.clientY
        }
    })
    const onPointerEnd = (e: PointerEvent) => {
        if (e.pointerId === stickId) {
            releaseStick()
        } else if (e.pointerId === lookId) {
            lookId = null
        }
    }
    layer.addEventListener("pointerup", onPointerEnd)
    layer.addEventListener("pointercancel", onPointerEnd)

    const addButton = (label: string, title: string, position: string) => {
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = label
        button.title = title
        button.setAttribute("aria-label", title)
        button.style.cssText = BUTTON_STYLE + position
        button.style.background = BUTTON_BACKGROUND
        // touches on a button neither look around nor move the joystick
        button.addEventListener("pointerdown", e => e.stopPropagation())
        layer.appendChild(button)
        return button
    }
    const highlight = (button: HTMLButtonElement, active: boolean) => {
        button.style.background = active ? BUTTON_ACTIVE_BACKGROUND : BUTTON_BACKGROUND
        button.setAttribute("aria-pressed", String(active))
    }
    const right = (column: number) => `right:calc(${16 + column * 64}px + env(safe-area-inset-right, 0px));`
    const bottom = (row: number) => `bottom:calc(${16 + row * 64}px + env(safe-area-inset-bottom, 0px));`

    // held buttons: up (jump while walking) and down
    let upHeld = false, downHeld = false
    const updateUp = () => input.up = (upHeld ? 1 : 0) - (downHeld ? 1 : 0)
    const addHoldButton = (label: string, title: string, position: string, set: (held: boolean) => void) => {
        const button = addButton(label, title, position)
        const hold = (held: boolean) => {
            set(held)
            updateUp()
            highlight(button, held)
        }
        button.addEventListener("pointerdown", e => {
            capture(button, e)
            hold(true)
        })
        button.addEventListener("pointerup", () => hold(false))
        button.addEventListener("pointercancel", () => hold(false))
        return { button, release: () => hold(false) }
    }
    const up = addHoldButton("▲", "Up / jump", right(0) + bottom(1), held => upHeld = held)
    const down = addHoldButton("▼", "Down", right(0) + bottom(0), held => downHeld = held)

    const fast = addButton("Fast", "Move faster", right(1) + bottom(0))
    const setFast = (enabled: boolean) => {
        input.fast = enabled
        highlight(fast, enabled)
    }
    fast.addEventListener("click", () => setFast(!input.fast))

    const walk = addButton("Walk", "Walking mode", right(1) + bottom(1))
    walk.addEventListener("click", () => handlers.toggleWalking())

    const noclip = addButton("Noclip", "Fly through the terrain", right(1) + bottom(2))
    noclip.style.fontSize = "12px"
    noclip.addEventListener("click", () => handlers.toggleNoclip())

    const close = addButton("✕", "Close the touch controls",
        "width:40px;height:40px;left:calc(8px + env(safe-area-inset-left, 0px));"
        + "top:calc(8px + env(safe-area-inset-top, 0px));")

    const deactivate = () => {
        layer.style.display = "none"
        releaseStick()
        lookId = null
        up.release()
        down.release()
        setFast(false)
    }
    close.addEventListener("click", () => {
        deactivate()
        handlers.deactivated()
    })

    return {
        input,
        activate: () => layer.style.display = "block",
        deactivate,
        setWalking: walking => {
            highlight(walk, walking)
            // there is no way down while walking
            down.release()
            down.button.style.display = walking ? "none" : "block"
            // noclip only applies to the flying camera
            noclip.style.display = walking ? "none" : "block"
        },
        setNoclip: enabled => highlight(noclip, enabled)
    }
}
