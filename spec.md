the plan is to create a 3d renderer library in typescript for luanti that runs in the browser.

# goals

* exportable npm library, written in typescript
* uses threejs for rendering
* can render exported scenes from the luanti engine (https://github.com/luanti-org/luanti/)

## scene definition

an exported scene example is in the "export" folder and contains:
* the node-definitions
* the mapblocks in json format
* in the "media" folder the textures and objects

# api

exposes the following javascript functions:

```ts
type ViewerOptions {
    
}

function createView(element: HTMLElement, options: ViewerOptions)
```