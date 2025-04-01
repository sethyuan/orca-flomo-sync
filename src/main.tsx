import { startOfDay } from "date-fns"
import { waitMs } from "jsutils"
import LogoImg from "../icon.png"
import { setupL10N, t } from "./libs/l10n"
import { ensureInbox, groupBy } from "./libs/utils"
import type { Block, DbId, QueryDescription } from "./orca"
import zhCN from "./translations/zhCN"

let pluginName: string

const WebviewID = "flomo-webview"

export async function load(_name: string) {
  pluginName = _name

  setupL10N(orca.state.locale, { "zh-CN": zhCN })

  const Button = orca.components.Button
  const HoverContextMenu = orca.components.HoverContextMenu
  const MenuText = orca.components.MenuText

  await orca.plugins.setSettingsSchema(pluginName, {
    inboxName: {
      label: t("Inbox name"),
      description: t(
        "The text used for the block where imported notes are placed under.",
      ),
      type: "string",
      defaultValue: "Flomo Inbox",
    },
    noteTag: {
      label: t("Note tag"),
      description: t("The tag applied to the imported notes."),
      type: "string",
      defaultValue: "Flomo Note",
    },
    afterDate: {
      label: t("After date"),
      description: t(
        "Notes before this date won't be synced, even in full sync mode.",
      ),
      type: "date",
      defaultValue: null,
    },
  })

  orca.themes.injectCSSResource(`${pluginName}/dist/main.css`, pluginName)

  if (orca.state.commands["flomo.sync"] == null) {
    orca.commands.registerCommand(
      "flomo.sync",
      async (fullSync: boolean = false) => {
        const settings = orca.state.plugins[pluginName].settings
        const inboxName = settings?.inboxName || "Flomo Inbox"
        const noteTag = settings?.noteTag || "Flomo Note"
        const afterDateValue = settings?.afterDate

        // Convert the after date to timestamp in seconds if available
        const afterDateTimestamp = afterDateValue
          ? Math.floor(new Date(afterDateValue).getTime() / 1000)
          : null

        // If we have both syncKey and an after date, use the greater value
        let effectiveSyncKey = null
        if (!fullSync) {
          const savedSyncKey = await orca.plugins.getData(pluginName, "syncKey")
          if (savedSyncKey && afterDateTimestamp) {
            effectiveSyncKey = Math.max(savedSyncKey, afterDateTimestamp)
          } else {
            effectiveSyncKey = savedSyncKey || afterDateTimestamp
          }
        } else if (afterDateTimestamp) {
          // In full sync mode, still respect the after date if it exists
          effectiveSyncKey = afterDateTimestamp
        }

        orca.notify("info", t("Starting to sync, please wait..."))

        if (orca.state.headbarButtons["flomo.webview"] == null) {
          orca.headbar.registerHeadbarButton("flomo.webview", () => (
            <webview
              id={WebviewID}
              className="flomo-webview"
              src="https://v.flomoapp.com/mine"
            />
          ))
          // Wait for webview to load before syncing
          await waitMs(100)
          await injectFunctions()
        }

        try {
          const loggedIn = await isLoggedIn()
          if (!loggedIn) {
            orca.notify("warn", t("Please log in to Flomo first."))
            await orca.commands.invokeCommand(
              "core.openWebViewModal",
              "https://v.flomoapp.com/mine",
            )
            return
          }

          const [fetchOK, notes] = await getNotes(effectiveSyncKey)
          if (!fetchOK) {
            console.error("Failed to open IndexedDB.")
            orca.notify("error", t("Failed to sync Flomo notes."))
            return
          }

          if (!notes?.length) {
            orca.notify("info", t("Nothing to sync."))
            return
          }

          const notesByDate = groupBy<number, any>(
            (note) => startOfDay(note.created_at).getTime(),
            notes,
          )

          await orca.commands.invokeGroup(async () => {
            for (const [date, notesInDate] of notesByDate.entries()) {
              const journal: Block = await orca.invokeBackend(
                "get-journal-block",
                new Date(date),
              )
              if (journal == null) continue
              const inbox = await ensureInbox(journal, inboxName)

              for (const note of notesInDate) {
                await syncNote(note, inbox, noteTag)
              }
            }
          })

          await orca.plugins.setData(
            pluginName,
            "syncKey",
            notes.at(-1).updated_at_long,
          )

          orca.notify("success", t("Flomo notes synced successfully."))
        } catch (err) {
          console.error("FLOMO SYNC:", err)
          orca.notify("error", t("Failed to sync Flomo notes."))
        } finally {
          orca.headbar.unregisterHeadbarButton("flomo.webview")
        }
      },
      t("Sync Flomo notes"),
    )
  }

  if (orca.state.headbarButtons["flomo.sync"] == null) {
    orca.headbar.registerHeadbarButton("flomo.sync", () => (
      <HoverContextMenu
        menu={(closeMenu: () => void) => (
          <>
            <MenuText
              title={t("Incremental sync")}
              onClick={async () => {
                closeMenu()
                await orca.commands.invokeCommand("flomo.sync")
              }}
            />
            <MenuText
              title={t("Full sync")}
              onClick={async () => {
                closeMenu()
                await orca.commands.invokeCommand("flomo.sync", true)
              }}
            />
          </>
        )}
      >
        <Button
          variant="plain"
          onClick={() => orca.commands.invokeCommand("flomo.sync")}
        >
          <img className="flomo-button" src={LogoImg} alt="Sync" />
        </Button>
      </HoverContextMenu>
    ))
  }

  console.log(`${pluginName} loaded.`)
}

export async function unload() {
  // Clean up any resources used by the plugin here.
  orca.headbar.unregisterHeadbarButton("flomo.sync")
  orca.commands.unregisterCommand("flomo.sync")
  orca.themes.removeCSSResources(pluginName)

  console.log(`${pluginName} unloaded.`)
}

async function syncNote(note: any, inbox: Block, noteTag: string) {
  let noteBlock: Block

  // Perform a query to see if there is an existing note.
  const resultIds = (await orca.invokeBackend("query", {
    q: {
      kind: 1,
      conditions: [
        {
          kind: 4,
          name: noteTag,
          properties: [{ name: "ID", op: 1, value: note.id }],
        },
      ],
    },
    pageSize: 1,
  } as QueryDescription)) as DbId[]

  if (resultIds.length > 0) {
    const noteBlockId = resultIds[0]
    noteBlock = orca.state.blocks[noteBlockId]
    if (noteBlock == null) {
      noteBlock = await orca.invokeBackend("get-block", noteBlockId)
      if (noteBlock == null) return
      orca.state.blocks[noteBlock.id] = noteBlock
    }

    // Clear the tags of the existing note.
    await orca.commands.invokeEditorCommand(
      "core.editor.setProperties",
      null,
      [noteBlock.id],
      [{ name: "_tags", type: 2, value: [] }],
    )

    // Clear the children of the existing note.
    if (noteBlock.children.length > 0) {
      await orca.commands.invokeEditorCommand(
        "core.editor.deleteBlocks",
        null,
        [...noteBlock.children],
      )
    }
  } else {
    const noteBlockId = await orca.commands.invokeEditorCommand(
      "core.editor.insertBlock",
      null,
      inbox,
      "lastChild",
      [{ t: "t", v: note.slug }],
      { type: "text" },
      new Date(note.created_at),
      new Date(note.updated_at),
    )
    noteBlock = orca.state.blocks[noteBlockId]
  }

  const tagBlockId = await orca.commands.invokeEditorCommand(
    "core.editor.insertTag",
    null,
    noteBlock.id,
    noteTag,
    [{ name: "ID", type: 1, value: note.id }],
  )
  // Add the ID tag property if it doesn't exist.
  const tagBlock = orca.state.blocks[tagBlockId]
  if (!tagBlock.properties?.some((p) => p.name === "ID")) {
    await orca.commands.invokeEditorCommand(
      "core.editor.setProperties",
      null,
      [tagBlock.id],
      [{ name: "ID", type: 1 }],
    )
  }

  // Add note tags.
  if (note.tags?.length) {
    for (const tag of note.tags) {
      await orca.commands.invokeEditorCommand(
        "core.editor.insertTag",
        null,
        noteBlock.id,
        tag,
      )
    }
  }

  for (const file of note.files) {
    const uploaded = await uploadAsset(file.url)
    if (!uploaded) continue
    await orca.commands.invokeEditorCommand(
      "core.editor.insertBlock",
      null,
      noteBlock,
      "firstChild",
      null,
      { type: file.type === "image" ? "image" : "audio", src: uploaded },
    )
  }

  // Insert the content of the note.
  await orca.commands.invokeEditorCommand(
    "core.editor.batchInsertHTML",
    null,
    noteBlock,
    "firstChild",
    note.content,
  )
}

function injectFunctions(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const webview = document.getElementById(WebviewID) as any
  async function query() {
    await webview.executeJavaScript(
      `(() => {
        window.fetchNotes = ${fetchNotes.toString()};
        window.fetchAsset = ${fetchAsset.toString()};
      })()`,
    )
    webview.removeEventListener("did-stop-loading", query)
    resolve()
  }
  webview.addEventListener("did-stop-loading", query)
  return promise
}

async function isLoggedIn(): Promise<boolean> {
  const webview = document.getElementById(WebviewID) as any
  const ret = await webview.executeJavaScript(
    `(() => {return document.querySelector(".el-container") != null})()`,
  )
  return ret
}

async function getNotes(syncKey: number): Promise<any[]> {
  const webview = document.getElementById(WebviewID) as any
  // Wait for flomo to sync itself.
  await waitMs(1000)
  return await webview.executeJavaScript(
    `(async () => {
      try {
        const notes = await fetchNotes(${syncKey})
        return [true, notes]
      } catch (err) {
        return [false, null]
      }
    })()`,
  )
}

async function uploadAsset(url: string): Promise<string> {
  const webview = document.getElementById(WebviewID) as any
  const [ok, mimeType, buffer] = await webview.executeJavaScript(
    `(async () => {
      try {
        const [mimeType, buffer] = await fetchAsset(${JSON.stringify(url)})
        return [true, mimeType, buffer]
      } catch (err) {
        return [false, null, null]
      }
    })()`,
  )
  if (!ok) return ""
  return await orca.invokeBackend("upload-asset-binary", mimeType, buffer)
}

function fetchNotes(syncKey?: number): Promise<any[]> {
  const { promise, resolve, reject } = Promise.withResolvers<any[]>()
  const req = window.indexedDB.open("flomo")
  req.onsuccess = (e: any) => {
    const db: IDBDatabase = e.target.result
    const index = db
      .transaction("memos", "readonly")
      .objectStore("memos")
      .index("updated_at_long")
    const lowerBound =
      syncKey == null ? null : IDBKeyRange.lowerBound(syncKey, true)
    const notes: any[] = []

    index.openCursor(lowerBound).onsuccess = (e: any) => {
      const cursor = e.target.result as IDBCursorWithValue
      if (cursor) {
        if (cursor.value.deleted_at == null) {
          notes.push(cursor.value)
          cursor.continue()
        } else {
          cursor.advance(1)
        }
      } else {
        resolve(notes)
      }
    }
  }
  req.onerror = (e) => {
    reject(e)
  }
  return promise
}

async function fetchAsset(url: string): Promise<[string, ArrayBuffer]> {
  const blob = await fetch(url).then((res) => res.blob())
  const arrayBuffer = await blob.arrayBuffer()
  return [blob.type, arrayBuffer]
}
