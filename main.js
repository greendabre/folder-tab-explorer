const { Plugin, ItemView, TFolder, TFile, Notice, Menu } = require("obsidian");

const VIEW_TYPE_WINDOWS_EXPLORER = "windows-explorer-tab-view";

class WindowsExplorerTabView extends ItemView {
    constructor(leaf) {
        super(leaf);
        this.currentPath = "";
        this.items = [];
        this.selectedPaths = new Set();
        this.lastSelectedIndex = -1;
        this.history = [];
        this.forwardHistory = [];
        this.lastVisitedChild = "";
        this.typeaheadQuery = "";
        this.typeaheadTimeout = null;
        this.isMarqueeDragging = false;
    }

    getViewType() {
        return VIEW_TYPE_WINDOWS_EXPLORER;
    }

    getDisplayText() {
        if (!this.currentPath) return "Vault";
        const segments = this.currentPath.split("/");
        return segments[segments.length - 1] || "Vault";
    }

    getIcon() {
        return "folder";
    }

    async onOpen() {
        // Pass false so the initial load is never pushed to history
        this.navigateTo(this.currentPath, false);

        this.registerEvent(this.app.vault.on("create", () => this.refresh()));
        this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
        this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
    }

    navigateTo(path, recordHistory = true) {
        const normalized = (path || "").replace(/^\/+|\/+$/g, "");
        const folder = normalized === "" 
            ? this.app.vault.getRoot() 
            : this.app.vault.getFolderByPath(normalized);

        if (folder instanceof TFolder) {
            // Only push to history if explicitly requested and the path is genuinely different
            if (recordHistory && this.currentPath !== normalized) {
                const lastHistory = this.history[this.history.length - 1];
                if (lastHistory !== this.currentPath) {
                    this.history.push(this.currentPath);
                }
                this.forwardHistory = [];
            }

            // Track folder we came from when moving upward
            if (this.currentPath.startsWith(normalized) && normalized !== this.currentPath) {
                const sub = this.currentPath.slice(normalized.length).replace(/^\//, "");
                this.lastVisitedChild = sub.split("/")[0];
            } else {
                this.lastVisitedChild = "";
            }

            this.currentPath = normalized;
            this.selectedPaths.clear();
            this.lastSelectedIndex = -1;
            this.loadFolderContents(folder);
            this.renderView();
            this.restoreScrollOrSelection();
        } else {
            new Notice(`Folder "${path}" does not exist.`);
        }
    }

    goBack() {
        if (this.history.length > 0) {
            const prev = this.history.pop();
            this.forwardHistory.push(this.currentPath);
            this.navigateTo(prev, false);
        } else {
            new Notice("No previous folder in history.");
        }
    }

    goForward() {
        if (this.forwardHistory.length > 0) {
            const next = this.forwardHistory.pop();
            this.history.push(this.currentPath);
            this.navigateTo(next, false);
        }
    }

    restoreScrollOrSelection() {
        if (!this.lastVisitedChild) return;
        const target = this.items.find(i => i.name === this.lastVisitedChild);
        if (target) {
            this.selectedPaths.add(target.path);
            this.lastSelectedIndex = this.items.indexOf(target);
            const container = this.containerEl.querySelector(".win-items-area");
            if (container) {
                this.updateSelectionVisuals(container);
                const targetRow = container.querySelector(`[data-path="${target.path}"]`);
                if (targetRow) {
                    targetRow.scrollIntoView({ block: "nearest" });
                }
            }
        }
    }

    refresh() {
        this.navigateTo(this.currentPath);
    }

    loadFolderContents(folder) {
        this.items = [...folder.children].sort((a, b) => {
            if (a instanceof TFolder && b instanceof TFile) return -1;
            if (a instanceof TFile && b instanceof TFolder) return 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });
    }

    renderView() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("win-explorer-root");
        container.setAttribute("tabindex", "0");

        // Toolbar / Address Bar
        const toolbar = container.createDiv({ cls: "win-toolbar" });

        const upBtn = toolbar.createEl("button", { cls: "win-btn", text: "↑" });
        upBtn.onclick = () => {
            if (!this.currentPath) return;
            const parts = this.currentPath.split("/");
            parts.pop();
            this.navigateTo(parts.join("/"));
        };

        const addressBar = toolbar.createEl("input", {
            cls: "win-address-bar",
            value: this.currentPath ? `Vault/${this.currentPath}` : "Vault"
        });

        addressBar.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                let target = addressBar.value.trim();
                if (target.startsWith("Vault")) {
                    target = target.replace(/^Vault\/?/, "");
                }
                this.navigateTo(target);
                container.focus();
            }
        });

        // Content Area
        const listContainer = container.createDiv({ cls: "win-items-area" });

        // Mouse buttons: 3 = Back, 4 = Forward (trap on both mousedown & mouseup to block Obsidian's native leaf history)
        const handleMouseNav = (e) => {
            if (e.button === 3) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (e.type === "mouseup") this.goBack();
            } else if (e.button === 4) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (e.type === "mouseup") this.goForward();
            }
        };

        container.addEventListener("mousedown", handleMouseNav);
        container.addEventListener("mouseup", handleMouseNav);

        // Rubber-band marquee drag selection box
        listContainer.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || e.target !== listContainer) return;
            const startX = e.clientX;
            const startY = e.clientY;
            const containerRect = listContainer.getBoundingClientRect();
            let dragged = false;

            const box = document.createElement("div");
            box.className = "win-selection-box";
            listContainer.appendChild(box);

            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                this.selectedPaths.clear();
                this.lastSelectedIndex = -1;
                this.updateSelectionVisuals(listContainer);
            }

            const onMouseMove = (moveEvent) => {
                const curX = moveEvent.clientX;
                const curY = moveEvent.clientY;
                if (!dragged && (Math.abs(curX - startX) > 3 || Math.abs(curY - startY) > 3)) {
                    dragged = true;
                    this.isMarqueeDragging = true;
                }
                if (!dragged) return;

                const x1 = Math.min(startX, curX) - containerRect.left + listContainer.scrollLeft;
                const y1 = Math.min(startY, curY) - containerRect.top + listContainer.scrollTop;
                const width = Math.abs(curX - startX);
                const height = Math.abs(curY - startY);

                box.style.left = `${x1}px`;
                box.style.top = `${y1}px`;
                box.style.width = `${width}px`;
                box.style.height = `${height}px`;

                const boxRect = box.getBoundingClientRect();
                const rows = listContainer.querySelectorAll(".win-item-row");
                rows.forEach((row) => {
                    const rRect = row.getBoundingClientRect();
                    const intersects = !(
                        boxRect.right < rRect.left ||
                        boxRect.left > rRect.right ||
                        boxRect.bottom < rRect.top ||
                        boxRect.top > rRect.bottom
                    );
                    const path = row.dataset.path;
                    if (path) {
                        if (intersects) {
                            this.selectedPaths.add(path);
                        } else if (!e.ctrlKey && !e.metaKey) {
                            this.selectedPaths.delete(path);
                        }
                    }
                });
                this.updateSelectionVisuals(listContainer);
            };

            const onMouseUp = () => {
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
                box.remove();
                if (dragged) {
                    setTimeout(() => {
                        this.isMarqueeDragging = false;
                    }, 50);
                }
            };

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });

        // Background click deselect (suppressed if finishing a marquee drag)
        listContainer.addEventListener("click", (e) => {
            if (e.target === listContainer && !this.isMarqueeDragging) {
                this.selectedPaths.clear();
                this.lastSelectedIndex = -1;
                this.updateSelectionVisuals(listContainer);
            }
        });

        // Background empty space context menu
        listContainer.addEventListener("contextmenu", (e) => {
            if (e.target === listContainer) {
                e.preventDefault();
                this.showFolderContextMenu(e);
            }
        });

        this.items.forEach((item, index) => {
            const row = listContainer.createDiv({
                cls: `win-item-row ${item instanceof TFolder ? "is-folder" : "is-file"}`
            });
            row.dataset.path = item.path;
            row.dataset.index = index.toString();
            row.draggable = true;

            // Drag Start
            row.addEventListener("dragstart", (e) => {
                if (!this.selectedPaths.has(item.path)) {
                    this.selectedPaths.clear();
                    this.selectedPaths.add(item.path);
                    this.lastSelectedIndex = index;
                    this.updateSelectionVisuals(listContainer);
                }
                const paths = Array.from(this.selectedPaths);
                this.plugin.draggedPaths = paths;
                e.dataTransfer.setData("application/json", JSON.stringify(paths));
                e.dataTransfer.setData("text/plain", paths.join("\n"));
                e.dataTransfer.effectAllowed = "move";
            });

            // Drag over / drop on folders
            if (item instanceof TFolder) {
                row.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    row.classList.add("is-drag-over");
                });
                row.addEventListener("dragleave", () => {
                    row.classList.remove("is-drag-over");
                });
                row.addEventListener("drop", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    row.classList.remove("is-drag-over");
                    const paths = this.extractDroppedPaths(e);
                    if (paths.length > 0) {
                        await this.moveItems(paths, item.path);
                    }
                });
            }

            row.createDiv({ cls: "win-item-icon", text: item instanceof TFolder ? "📁" : "📄" });
            const labelContainer = row.createDiv({ cls: "win-item-label-container" });
            const label = labelContainer.createDiv({ cls: "win-item-label", text: item.name });

            // Selection Logic
            row.addEventListener("click", (e) => {
                e.stopPropagation();
                if (e.shiftKey && this.lastSelectedIndex !== -1) {
                    this.handleRangeSelect(this.lastSelectedIndex, index);
                } else if (e.ctrlKey || e.metaKey) {
                    if (this.selectedPaths.has(item.path)) {
                        this.selectedPaths.delete(item.path);
                    } else {
                        this.selectedPaths.add(item.path);
                        this.lastSelectedIndex = index;
                    }
                } else {
                    this.selectedPaths.clear();
                    this.selectedPaths.add(item.path);
                    this.lastSelectedIndex = index;
                }
                this.updateSelectionVisuals(listContainer);
            });

            // Desktop double-click
            row.addEventListener("dblclick", () => {
                this.openItem(item);
            });

            // Mobile single tap
            row.addEventListener("touchend", () => {
                if (document.body.hasClass("is-mobile")) {
                    this.openItem(item);
                }
            });

            // Context Menu
            row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                if (!this.selectedPaths.has(item.path)) {
                    this.selectedPaths.clear();
                    this.selectedPaths.add(item.path);
                    this.lastSelectedIndex = index;
                    this.updateSelectionVisuals(listContainer);
                }
                this.showContextMenu(e, item, labelContainer, label);
            });
        });
		
		listContainer.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        });
        listContainer.addEventListener("drop", async (e) => {
            if (e.target === listContainer) {
                e.preventDefault();
                const paths = this.extractDroppedPaths(e);
                if (paths.length > 0) {
                    await this.moveItems(paths, this.currentPath);
                }
            }
        });

        container.onkeydown = (e) => {
            this.handleKeyNavigation(e, listContainer);
        };
    }

    handleRangeSelect(start, end) {
        this.selectedPaths.clear();
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let i = min; i <= max; i++) {
            this.selectedPaths.add(this.items[i].path);
        }
    }

    updateSelectionVisuals(container) {
        const rows = container.querySelectorAll(".win-item-row");
        const cutPaths = (this.plugin.clipboard && this.plugin.clipboard.action === "cut")
            ? new Set(this.plugin.clipboard.paths)
            : new Set();

        rows.forEach((rowEl) => {
            const path = rowEl.dataset.path;
            if (path && this.selectedPaths.has(path)) {
                rowEl.classList.add("is-selected");
            } else {
                rowEl.classList.remove("is-selected");
            }

            if (path && cutPaths.has(path)) {
                rowEl.classList.add("is-cut");
            } else {
                rowEl.classList.remove("is-cut");
            }
        });
    }

    openItem(item) {
        if (item instanceof TFolder) {
            this.navigateTo(item.path);
        } else if (item instanceof TFile) {
            this.app.workspace.getLeaf("tab").openFile(item);
        }
    }

    handleKeyNavigation(e, listContainer) {
        // Cut / Copy / Paste Shortcuts
        if (e.ctrlKey || e.metaKey) {
            if (e.key.toLowerCase() === "c") {
                e.preventDefault();
                this.setClipboard("copy");
                return;
            } else if (e.key.toLowerCase() === "x") {
                e.preventDefault();
                this.setClipboard("cut");
                return;
            } else if (e.key.toLowerCase() === "v") {
                e.preventDefault();
                this.pasteClipboard();
                return;
            } else if (e.key.toLowerCase() === "a") {
                e.preventDefault();
                this.selectedPaths = new Set(this.items.map(i => i.path));
                this.updateSelectionVisuals(listContainer);
                return;
            }
        }

        // Arrow Navigation
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            let nextIndex = this.lastSelectedIndex;
            if (e.key === "ArrowDown") nextIndex = Math.min(this.items.length - 1, nextIndex + 1);
            if (e.key === "ArrowUp") nextIndex = Math.max(0, nextIndex - 1);

            if (e.shiftKey) {
                this.handleRangeSelect(this.lastSelectedIndex !== -1 ? this.lastSelectedIndex : 0, nextIndex);
            } else {
                this.selectedPaths.clear();
                this.selectedPaths.add(this.items[nextIndex].path);
                this.lastSelectedIndex = nextIndex;
            }
            this.updateSelectionVisuals(listContainer);
            const targetRow = listContainer.querySelector(`[data-path="${this.items[nextIndex].path}"]`);
            if (targetRow) targetRow.scrollIntoView({ block: "nearest" });
            return;
        }

        if (e.key === "Enter") {
            if (this.selectedPaths.size === 1) {
                const target = this.items.find(i => this.selectedPaths.has(i.path));
                if (target) this.openItem(target);
            }
            return;
        }

        if (e.key === "F2") {
            if (this.selectedPaths.size === 1) {
                const target = this.items.find(i => this.selectedPaths.has(i.path));
                const targetRow = listContainer.querySelector(`[data-path="${target ? target.path : ""}"]`);
                if (target && targetRow) {
                    const labelContainer = targetRow.querySelector(".win-item-label-container");
                    const label = targetRow.querySelector(".win-item-label");
                    this.beginInlineRename(target, labelContainer, label);
                }
            }
            return;
        }

        if (e.key === "Delete") {
            this.deleteSelected();
            return;
        }

        // Typeahead navigation (Pressing letters/numbers jumps to match)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            clearTimeout(this.typeaheadTimeout);
            this.typeaheadQuery += e.key.toLowerCase();
            this.typeaheadTimeout = setTimeout(() => {
                this.typeaheadQuery = "";
            }, 600);

            const matchIndex = this.items.findIndex(item =>
                item.name.toLowerCase().startsWith(this.typeaheadQuery)
            );

            if (matchIndex !== -1) {
                this.selectedPaths.clear();
                this.selectedPaths.add(this.items[matchIndex].path);
                this.lastSelectedIndex = matchIndex;
                this.updateSelectionVisuals(listContainer);
                const targetRow = listContainer.querySelector(`[data-path="${this.items[matchIndex].path}"]`);
                if (targetRow) targetRow.scrollIntoView({ block: "nearest" });
            }
        }
    }

    beginInlineRename(item, labelContainer, label) {
        label.style.display = "none";
        const input = labelContainer.createEl("input", {
            cls: "win-rename-input",
            value: item.name
        });
        input.focus();

        if (item instanceof TFile && item.extension) {
            const extLength = item.extension.length + 1;
            input.setSelectionRange(0, item.name.length - extLength);
        } else {
            input.select();
        }

        const commitRename = async () => {
            const newName = input.value.trim();
            input.remove();
            label.style.display = "";

            if (newName && newName !== item.name) {
                const parentPath = item.parent && item.parent.path !== "/" ? item.parent.path : "";
                const newPath = parentPath ? `${parentPath}/${newName}` : newName;
                try {
                    // Triggers Obsidian's link resolver to update backlinks vault-wide
                    await this.app.fileManager.renameFile(item, newPath);
                    this.refresh();
                } catch (err) {
                    new Notice(`Rename failed: ${err.message}`);
                }
            }
        };

        input.addEventListener("blur", () => commitRename());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                commitRename();
            } else if (e.key === "Escape") {
                input.remove();
                label.style.display = "";
            }
        });
    }

    async deleteSelected() {
        if (this.selectedPaths.size === 0) return;
        const confirmMsg = `Send ${this.selectedPaths.size} item(s) to trash?`;
        if (confirm(confirmMsg)) {
            for (const path of this.selectedPaths) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file) {
                    await this.app.vault.trash(file, true);
                }
            }
            this.selectedPaths.clear();
            this.refresh();
        }
    }

    showContextMenu(e, item, labelContainer, label) {
        const menu = new Menu();

        // 1. If it's a folder, provide the Windows Explorer open tab option first
        if (item instanceof TFolder) {
            menu.addItem((i) =>
                i.setTitle("Open in new explorer tab").setIcon("external-link").onClick(() => {
                    this.plugin.openExplorerTab(item.path);
                })
            );
            menu.addSeparator();
        }

        // 2. Windows Explorer operations (Cut, Copy, Paste)
        menu.addItem((i) =>
            i.setTitle("Cut").setIcon("scissors").onClick(() => {
                this.setClipboard("cut");
            })
        );

        menu.addItem((i) =>
            i.setTitle("Copy").setIcon("copy").onClick(() => {
                this.setClipboard("copy");
            })
        );

        if (this.plugin.clipboard && this.plugin.clipboard.paths.length > 0) {
            menu.addItem((i) =>
                i.setTitle("Paste").setIcon("clipboard").onClick(() => {
                    this.pasteClipboard();
                })
            );
        }

        menu.addSeparator();

        // 3. Populate all standard Obsidian items & plugins (New note/canvas/base, Bookmarks, Templates, etc.)
        this.app.workspace.trigger("file-menu", menu, item, "file-explorer", this.leaf);

        menu.showAtMouseEvent(e);
    }

    showFolderContextMenu(e) {
        const menu = new Menu();
        const currentFolder = this.currentPath === ""
            ? this.app.vault.getRoot()
            : this.app.vault.getFolderByPath(this.currentPath);

        if (!currentFolder) return;

        // Windows Explorer Paste if something is in the clipboard
        if (this.plugin.clipboard && this.plugin.clipboard.paths.length > 0) {
            menu.addItem((i) =>
                i.setTitle("Paste").setIcon("clipboard").onClick(() => {
                    this.pasteClipboard();
                })
            );
            menu.addSeparator();
        }

        // Populate every native folder option (New note, New folder, New canvas, New base, Search, Templates, etc.)
        this.app.workspace.trigger("file-menu", menu, currentFolder, "file-explorer", this.leaf);

        menu.showAtMouseEvent(e);
    }
	
	setClipboard(action) {
        if (this.selectedPaths.size === 0) return;
        this.plugin.clipboard = {
            action: action, // "copy" or "cut"
            paths: Array.from(this.selectedPaths)
        };
        const count = this.selectedPaths.size;
        new Notice(`${action === "cut" ? "Cut" : "Copied"} ${count} item(s)`);
        this.plugin.notifyClipboardUpdate();
    }

    async pasteClipboard() {
        if (!this.plugin.clipboard || this.plugin.clipboard.paths.length === 0) return;
        const { action, paths } = this.plugin.clipboard;
        const destDir = this.currentPath;

        new Notice(`Pasting ${paths.length} item(s)...`);

        for (const sourcePath of paths) {
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!file) continue;

            const targetName = file.name;
            const newPath = destDir ? `${destDir}/${targetName}` : targetName;

            if (action === "cut") {
                if (sourcePath !== newPath) {
                    try {
                        await this.app.fileManager.renameFile(file, newPath);
                    } catch (err) {
                        new Notice(`Move failed: ${err.message}`);
                    }
                }
            } else if (action === "copy") {
                if (file instanceof TFile) {
                    try {
                        let finalPath = newPath;
                        if (await this.app.vault.adapter.exists(finalPath)) {
                            const ext = file.extension ? `.${file.extension}` : "";
                            const base = file.basename;
                            finalPath = destDir ? `${destDir}/${base} - Copy${ext}` : `${base} - Copy${ext}`;
                        }
                        const content = await this.app.vault.readBinary(file);
                        await this.app.vault.createBinary(finalPath, content);
                    } catch (err) {
                        new Notice(`Copy failed: ${err.message}`);
                    }
                }
            }
        }

        new Notice(`Completed paste operation.`);
        if (action === "cut") {
            this.plugin.clipboard = null;
            this.plugin.notifyClipboardUpdate();
        }
        this.refresh();
    }
	
	extractDroppedPaths(e) {
        let paths = this.plugin.draggedPaths || [];
        if (paths.length === 0) {
            try {
                const raw = e.dataTransfer.getData("application/json");
                if (raw) paths = JSON.parse(raw);
            } catch (_) {}
        }
        return paths;
    }

    async moveItems(sourcePaths, targetFolderPath) {
        new Notice(`Moving ${sourcePaths.length} item(s)...`);
        for (const p of sourcePaths) {
            const file = this.app.vault.getAbstractFileByPath(p);
            if (!file) continue;
            // Prevent dragging a folder inside itself
            if (file instanceof TFolder && (targetFolderPath === p || targetFolderPath.startsWith(p + "/"))) {
                continue;
            }
            const newPath = targetFolderPath ? `${targetFolderPath}/${file.name}` : file.name;
            if (p !== newPath) {
                try {
                    await this.app.fileManager.renameFile(file, newPath);
                } catch (err) {
                    new Notice(`Move error: ${err.message}`);
                }
            }
        }
        new Notice(`Move complete.`);
        this.plugin.draggedPaths = [];
        this.refresh();
    }
}

class WindowsExplorerPlugin extends Plugin {
    async onload() {
        this.clipboard = null;
        this.draggedPaths = [];

        this.registerView(
            VIEW_TYPE_WINDOWS_EXPLORER,
            (leaf) => {
                const view = new WindowsExplorerTabView(leaf);
                view.plugin = this;
                return view;
            }
        );

        this.addRibbonIcon("folder-tree", "Open Windows Explorer Tab", () => {
            this.openExplorerTab();
        });

        this.addCommand({
            id: "open-windows-explorer-tab",
            name: "Open Windows Explorer Tab",
            callback: () => {
                this.openExplorerTab();
            }
        });
    }

    notifyClipboardUpdate() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WINDOWS_EXPLORER);
        for (const leaf of leaves) {
            if (leaf.view instanceof WindowsExplorerTabView) {
                const container = leaf.view.containerEl.querySelector(".win-items-area");
                if (container) {
                    leaf.view.updateSelectionVisuals(container);
                }
            }
        }
    }

    async openExplorerTab(targetPath = "") {
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({
            type: VIEW_TYPE_WINDOWS_EXPLORER,
            active: true
        });
        if (leaf.view instanceof WindowsExplorerTabView && targetPath) {
            leaf.view.navigateTo(targetPath);
        }
        this.app.workspace.revealLeaf(leaf);
    }
}

module.exports = WindowsExplorerPlugin;
