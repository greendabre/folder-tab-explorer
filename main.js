const { Plugin, ItemView, TFolder, TFile, Notice, Menu, PluginSettingTab, Setting } = require("obsidian");

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
		this.isRenaming = false;
		this.expandedPaths = new Set();
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
        } else if (this.currentPath !== "") {
            const parts = this.currentPath.split("/");
            parts.pop();
            const parent = parts.join("/");
            this.forwardHistory.push(this.currentPath);
            this.navigateTo(parent, false);
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
        const container = this.containerEl.querySelector(".win-items-area");
        const savedScrollTop = container ? container.scrollTop : 0;
        this.navigateTo(this.currentPath, false);
        const updatedContainer = this.containerEl.querySelector(".win-items-area");
        if (updatedContainer) {
            updatedContainer.scrollTop = savedScrollTop;
        }
    }

    loadFolderContents(folder) {
        if (!this.isLeftmostTab()) {
            this.items = [...folder.children].sort((a, b) => {
                if (a instanceof TFolder && b instanceof TFile) return -1;
                if (a instanceof TFile && b instanceof TFolder) return 1;
                return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
            });
            return;
        }

        // Build a flattened view of expanded tree items for the leftmost tab
        const flattened = [];
        const traverse = (dir, depth = 0) => {
            const children = [...dir.children].sort((a, b) => {
                if (a instanceof TFolder && b instanceof TFile) return -1;
                if (a instanceof TFile && b instanceof TFolder) return 1;
                return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
            });

            for (const child of children) {
                child._depth = depth;
                flattened.push(child);
                if (child instanceof TFolder && this.expandedPaths.has(child.path)) {
                    traverse(child, depth + 1);
                }
            }
        };

        traverse(folder, 0);
        this.items = flattened;
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

        const isLeftmost = this.isLeftmostTab();

        this.items.forEach((item, index) => {
            const row = listContainer.createDiv({
                cls: `win-item-row ${item instanceof TFolder ? "is-folder" : "is-file"}`
            });
            row.dataset.path = item.path;
            row.dataset.index = index.toString();
            row.draggable = !this.isRenaming;

            // Apply indentation for nested subfolders in leftmost tab
            const depth = item._depth || 0;
            if (depth > 0) {
                row.style.paddingLeft = `${depth * 18 + 8}px`;
            }

            // Arrow toggle for expandable folders in leftmost tab
            if (isLeftmost) {
                if (item instanceof TFolder) {
                    const isExpanded = this.expandedPaths.has(item.path);
                    const arrow = row.createDiv({
                        cls: "win-item-arrow",
                        text: isExpanded ? "▼" : "▶"
                    });
                    arrow.onclick = (e) => {
                        e.stopPropagation();
                        if (this.expandedPaths.has(item.path)) {
                            this.expandedPaths.delete(item.path);
                        } else {
                            this.expandedPaths.add(item.path);
                        }
                        this.refresh();
                    };
                } else {
                    row.createDiv({ cls: "win-item-arrow is-spacer" });
                }
            }

            row.createDiv({ cls: "win-item-icon", text: item instanceof TFolder ? "📁" : "📄" });
            const labelContainer = row.createDiv({ cls: "win-item-label-container" });
            const label = labelContainer.createDiv({ cls: "win-item-label", text: item.name });

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

                    // If clicking a folder in the leftmost pane without modifiers, project it to the right
                    if (item instanceof TFolder && this.isLeftmostTab()) {
                        this.openOrUpdateRightPane(item.path);
                    }
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

        // Determine reference parent based on anchor item
        const anchorItem = this.items[this.lastSelectedIndex !== -1 ? this.lastSelectedIndex : start];
        const targetParentPath = anchorItem?.parent?.path ?? "";

        // Only select items that share the exact same parent directory level
        for (let i = min; i <= max; i++) {
            const item = this.items[i];
            const itemParentPath = item?.parent?.path ?? "";
            if (itemParentPath === targetParentPath) {
                this.selectedPaths.add(item.path);
            }
        }

        // Pruning guard: Ensure no selected folder is an ancestor of another selected item
        const selectedArray = Array.from(this.selectedPaths);
        for (const path of selectedArray) {
            for (const otherPath of selectedArray) {
                if (path !== otherPath && otherPath.startsWith(path + "/")) {
                    this.selectedPaths.delete(otherPath);
                }
            }
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
	
	isLeftmostTab() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WINDOWS_EXPLORER);
        if (leaves.length <= 1) return true;

        const myRect = this.containerEl.getBoundingClientRect();
        for (const other of leaves) {
            if (other === this.leaf) continue;
            const otherRect = other.view.containerEl.getBoundingClientRect();
            // If another explorer leaf has a noticeably smaller horizontal offset, this is not the leftmost
            if (otherRect.left < myRect.left - 5) {
                return false;
            }
        }
        return true;
    }

    async openOrUpdateRightPane(folderPath) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WINDOWS_EXPLORER);
        if (leaves.length === 0) return;

        // Sort all open explorer leaves by spatial/layout position (left-to-right, then top-to-bottom)
        const sortedLeaves = [...leaves].sort((a, b) => {
            const rectA = a.view.containerEl.getBoundingClientRect();
            const rectB = b.view.containerEl.getBoundingClientRect();
            if (Math.abs(rectA.left - rectB.left) > 5) {
                return rectA.left - rectB.left;
            }
            return rectA.top - rectB.top;
        });

        // The leftmost tab is index 0
        const leftmostLeaf = sortedLeaves[0];

        // Only the leftmost tab triggers this action
        if (this.leaf !== leftmostLeaf) return;

        // Target the very next explorer tab immediately after the leftmost one (index 1)
        const targetLeaf = sortedLeaves[1];

        if (targetLeaf && targetLeaf.view instanceof WindowsExplorerTabView) {
            this.app.workspace.revealLeaf(targetLeaf);
            targetLeaf.view.navigateTo(folderPath);
        } else {
            // If no second explorer tab exists anywhere, open one in a vertical split to the right
            await this.plugin.openExplorerTab(folderPath, true);
        }
    }

    openItem(item) {
        if (item instanceof TFolder) {
            this.navigateTo(item.path);
        } else if (item instanceof TFile) {
            this.app.workspace.getLeaf("tab").openFile(item);
        }
    }

    handleKeyNavigation(e, listContainer) {
        if (this.isRenaming) return;

        // Do not intercept keystrokes if the user is typing in an editor, input field, or modal
        const active = document.activeElement;
        if (
            active &&
            (active.tagName === "INPUT" ||
             active.tagName === "TEXTAREA" ||
             active.isContentEditable ||
             active.closest(".cm-editor") ||
             active.closest(".modal"))
        ) {
            return;
        }

        // Only handle navigation if focus is actually inside this explorer view
        if (!this.containerEl.contains(active)) {
            return;
        }

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

        // Navigation Keys (Arrows, Home, End, PageUp, PageDown)
        if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)) {
            e.preventDefault();
            if (this.items.length === 0) return;

            let nextIndex = this.lastSelectedIndex === -1 ? 0 : this.lastSelectedIndex;
            const pageSize = Math.max(1, Math.floor(listContainer.clientHeight / 28));

            if (e.key === "ArrowDown") {
                nextIndex = Math.min(this.items.length - 1, nextIndex + 1);
            } else if (e.key === "ArrowUp") {
                nextIndex = Math.max(0, nextIndex - 1);
            } else if (e.key === "Home") {
                nextIndex = 0;
            } else if (e.key === "End") {
                nextIndex = this.items.length - 1;
            } else if (e.key === "PageDown") {
                nextIndex = Math.min(this.items.length - 1, nextIndex + pageSize);
            } else if (e.key === "PageUp") {
                nextIndex = Math.max(0, nextIndex - pageSize);
            }

            if (e.shiftKey) {
                this.handleRangeSelect(this.lastSelectedIndex !== -1 ? this.lastSelectedIndex : 0, nextIndex);
            } else {
                this.selectedPaths.clear();
                const targetItem = this.items[nextIndex];
                this.selectedPaths.add(targetItem.path);
                this.lastSelectedIndex = nextIndex;

                // Project folder contents to right pane when navigating via keyboard in the leftmost tab
                if (targetItem instanceof TFolder && this.isLeftmostTab()) {
                    this.openOrUpdateRightPane(targetItem.path);
                }
            }

            this.updateSelectionVisuals(listContainer);
            const targetRow = listContainer.querySelector(`[data-path="${CSS.escape(this.items[nextIndex].path)}"]`);
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
            this.triggerRenameForSelected();
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
	
	openMoveModalForSelected() {
        if (this.selectedPaths.size === 0) return;
        const allFolders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder);
        
        const fuzzyModal = new (require("obsidian").FuzzySuggestModal)(this.app);
        fuzzyModal.getItems = () => allFolders;
        fuzzyModal.getItemText = (folder) => folder.path === "/" ? "/" : folder.path;
        fuzzyModal.onChooseItem = async (folder) => {
            const destPath = folder.path === "/" ? "" : folder.path;
            const paths = Array.from(this.selectedPaths);
            await this.moveItems(paths, destPath);
        };
        fuzzyModal.setPlaceholder("Move selected item(s) to folder...");
        fuzzyModal.open();
    }
	
	triggerRenameForSelected() {
        if (this.selectedPaths.size !== 1) return;
        const targetPath = Array.from(this.selectedPaths)[0];
        const target = this.app.vault.getAbstractFileByPath(targetPath);
        if (!target) return;

        const container = this.containerEl.querySelector(".win-items-area");
        if (!container) return;

        const targetRow = container.querySelector(`[data-path="${CSS.escape(target.path)}"]`);
        if (targetRow) {
            const labelContainer = targetRow.querySelector(".win-item-label-container");
            const label = targetRow.querySelector(".win-item-label");
            if (labelContainer && label) {
                this.beginInlineRename(target, labelContainer, label);
            }
        }
    }

    beginInlineRename(item, labelContainer, label) {
        this.isRenaming = true;
        const row = labelContainer.closest(".win-item-row");
        if (row) {
            row.draggable = false;
        }

        label.style.display = "none";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "win-rename-input";
        input.value = item.name;
        labelContainer.appendChild(input);

        // Prevent container and leaf from capturing mouse clicks
        const stopEvent = (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        input.addEventListener("mousedown", stopEvent);
        input.addEventListener("mouseup", stopEvent);
        input.addEventListener("click", stopEvent);
        input.addEventListener("dblclick", stopEvent);

        const cleanup = () => {
            this.isRenaming = false;
            if (row) {
                row.draggable = true;
            }
            input.remove();
            label.style.display = "";
            const container = this.containerEl.querySelector(".win-explorer-root");
            if (container) container.focus();
        };

        const commitRename = async () => {
            const newName = input.value.trim();
            cleanup();

            if (newName && newName !== item.name) {
                const parentPath = item.parent && item.parent.path !== "/" ? item.parent.path : "";
                const newPath = parentPath ? `${parentPath}/${newName}` : newName;
                try {
                    await this.app.fileManager.renameFile(item, newPath);
                    this.refresh();
                } catch (err) {
                    new Notice(`Rename failed: ${err.message}`);
                }
            }
        };

        // Trap keystrokes on the input element
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
            } else if (e.key === "Escape") {
                e.preventDefault();
                cleanup();
            }
        });

        input.addEventListener("keyup", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        });

        input.addEventListener("keypress", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        });

        input.addEventListener("blur", () => {
            commitRename();
        });

        // Focus and select text
        requestAnimationFrame(() => {
            input.focus();
            if (item instanceof TFile && item.extension) {
                const extLength = item.extension.length + 1;
                input.setSelectionRange(0, item.name.length - extLength);
            } else {
                input.select();
            }
        });
    }

    async deleteSelected() {
        if (this.selectedPaths.size === 0) return;

        const shouldConfirm = this.plugin?.settings?.confirmDelete ?? true;
        if (shouldConfirm) {
            const confirmMsg = `Send ${this.selectedPaths.size} item(s) to trash?`;
            if (!confirm(confirmMsg)) return;
        }

        // Snapshot and sort deepest paths first to prevent parent deletions from breaking child references
        const pathsToDelete = Array.from(this.selectedPaths).sort((a, b) => b.length - a.length);
        this.selectedPaths.clear();

        for (const path of pathsToDelete) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file) {
                try {
                    await this.app.vault.trash(file, true);
                } catch (err) {
                    new Notice(`Failed to delete ${file.name}: ${err.message}`);
                }
            }
        }
        this.refresh();
    }

async createNewItem(type, targetFolder) {
        const folderPath = targetFolder.path === "/" ? "" : targetFolder.path;
        let ext = "";
        let defaultName = "";

        if (type === "note") {
            ext = ".md";
            defaultName = "Untitled";
        } else if (type === "canvas") {
            ext = ".canvas";
            defaultName = "Untitled";
        } else if (type === "base") {
            ext = ".base";
            defaultName = "Untitled";
        }

        if (type === "folder") {
            let counter = 0;
            let folderName = "Untitled folder";
            let newPath = folderPath ? `${folderPath}/${folderName}` : folderName;
            while (await this.app.vault.adapter.exists(newPath)) {
                counter++;
                folderName = `Untitled folder ${counter}`;
                newPath = folderPath ? `${folderPath}/${folderName}` : folderName;
            }
            await this.app.vault.createFolder(newPath);
            this.refresh();
            return;
        }

        let counter = 0;
        let baseName = defaultName;
        let newPath = folderPath ? `${folderPath}/${baseName}${ext}` : `${baseName}${ext}`;
        while (await this.app.vault.adapter.exists(newPath)) {
            counter++;
            baseName = `${defaultName} ${counter}`;
            newPath = folderPath ? `${folderPath}/${baseName}${ext}` : `${baseName}${ext}`;
        }

        const newFile = await this.app.vault.create(newPath, "");
        this.refresh();
        if (newFile instanceof TFile) {
            this.app.workspace.getLeaf("tab").openFile(newFile);
        }
    }

    populateCoreFolderActions(menu, folder) {
        menu.addItem((i) =>
            i.setTitle("New note").setIcon("edit").onClick(() => {
                this.createNewItem("note", folder);
            })
        );

        menu.addItem((i) =>
            i.setTitle("New folder").setIcon("folder").onClick(() => {
                this.createNewItem("folder", folder);
            })
        );

        menu.addItem((i) =>
            i.setTitle("New canvas").setIcon("layout-grid").onClick(() => {
                this.createNewItem("canvas", folder);
            })
        );

        // Core base creation support if available
        menu.addItem((i) =>
            i.setTitle("New base").setIcon("table").onClick(() => {
                this.createNewItem("base", folder);
            })
        );

        menu.addSeparator();

        menu.addItem((i) =>
            i.setTitle("Make a copy").setIcon("documents").onClick(async () => {
                if (folder instanceof TFile) {
                    const ext = folder.extension ? `.${folder.extension}` : "";
                    const parent = folder.parent ? folder.parent.path : "";
                    const copyPath = parent ? `${parent}/${folder.basename} 1${ext}` : `${folder.basename} 1${ext}`;
                    const content = await this.app.vault.readBinary(folder);
                    await this.app.vault.createBinary(copyPath, content);
                    this.refresh();
                }
            })
        );

        menu.addItem((i) =>
            i.setTitle("Search in folder").setIcon("search").onClick(() => {
                const searchPlugin = this.app.internalPlugins?.getPluginById("global-search");
                if (searchPlugin && searchPlugin.instance) {
                    const query = `path:"${folder.path}"`;
                    searchPlugin.instance.openGlobalSearch(query);
                }
            })
        );
    }

    showContextMenu(e, item, labelContainer, label) {
        const menu = new Menu();

        if (item instanceof TFolder) {
            this.populateCoreFolderActions(menu, item);
            menu.addSeparator();

            menu.addItem((i) =>
                i.setTitle("Open in new explorer tab").setIcon("external-link").onClick(() => {
                    this.plugin.openExplorerTab(item.path, false);
                })
            );

            menu.addItem((i) =>
                i.setTitle("Open in new explorer tab to the right").setIcon("split").onClick(() => {
                    this.plugin.openExplorerTab(item.path, true);
                })
            );
            menu.addSeparator();
        }

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

        menu.addItem((i) =>
            i.setTitle("Rename...").setIcon("pencil").onClick(() => {
                this.triggerRenameForSelected();
            })
        );

        menu.addItem((i) =>
            i.setTitle("Delete").setIcon("trash").onClick(async () => {
                await this.deleteSelected();
            })
        );

        menu.addSeparator();

        if (this.selectedPaths.size > 1) {
            menu.addItem((i) =>
                i.setTitle(`Move ${this.selectedPaths.size} items to...`).setIcon("folder-input").onClick(() => {
                    this.openMoveModalForSelected();
                })
            );
            menu.addSeparator();
        }

        // Community plugins and core file options (Bookmarks, Templater, Ask Gemini, etc.)
        this.app.workspace.trigger("file-menu", menu, item, "file-explorer", this.leaf);

        menu.showAtMouseEvent(e);
    }

    showFolderContextMenu(e) {
        const menu = new Menu();
        const currentFolder = this.currentPath === ""
            ? this.app.vault.getRoot()
            : this.app.vault.getFolderByPath(this.currentPath);

        if (!currentFolder) return;

        this.populateCoreFolderActions(menu, currentFolder);
        menu.addSeparator();

        if (this.plugin.clipboard && this.plugin.clipboard.paths.length > 0) {
            menu.addItem((i) =>
                i.setTitle("Paste").setIcon("clipboard").onClick(() => {
                    this.pasteClipboard();
                })
            );
            menu.addSeparator();
        }

        // Community plugins and folder hooks
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
	
	async getUniqueDestinationPath(destFolderPath, fileName) {
        const lastDot = fileName.lastIndexOf(".");
        const hasExt = lastDot > 0;
        const base = hasExt ? fileName.substring(0, lastDot) : fileName;
        const ext = hasExt ? fileName.substring(lastDot) : "";

        const dirPrefix = destFolderPath ? `${destFolderPath}/` : "";
        let candidatePath = `${dirPrefix}${fileName}`;

        if (!await this.app.vault.adapter.exists(candidatePath)) {
            return candidatePath;
        }

        // Try standard " - Copy"
        candidatePath = `${dirPrefix}${base} - Copy${ext}`;
        if (!await this.app.vault.adapter.exists(candidatePath)) {
            return candidatePath;
        }

        // Increment " - Copy (2)", " - Copy (3)", etc.
        let counter = 2;
        while (await this.app.vault.adapter.exists(`${dirPrefix}${base} - Copy (${counter})${ext}`)) {
            counter++;
        }

        return `${dirPrefix}${base} - Copy (${counter})${ext}`;
    }
	
	async mergeMoveFolder(sourceFolder, destFolderPath) {
        if (!await this.app.vault.adapter.exists(destFolderPath)) {
            await this.app.fileManager.renameFile(sourceFolder, destFolderPath);
            return;
        }

        const children = [...sourceFolder.children];
        for (const child of children) {
            const childDestPath = `${destFolderPath}/${child.name}`;
            if (child instanceof TFolder) {
                await this.mergeMoveFolder(child, childDestPath);
            } else if (child instanceof TFile) {
                const uniquePath = await this.getUniqueDestinationPath(destFolderPath, child.name);
                await this.app.fileManager.renameFile(child, uniquePath);
            }
        }

        if (sourceFolder.children.length === 0) {
            await this.app.vault.trash(sourceFolder, false);
        }
    }

    async recursiveCopy(sourceItem, destPath) {
        if (sourceItem instanceof TFile) {
            const parent = destPath.substring(0, destPath.lastIndexOf("/"));
            const uniquePath = await this.getUniqueDestinationPath(parent, sourceItem.name);
            const content = await this.app.vault.readBinary(sourceItem);
            await this.app.vault.createBinary(uniquePath, content);
        } else if (sourceItem instanceof TFolder) {
            if (!await this.app.vault.adapter.exists(destPath)) {
                await this.app.vault.createFolder(destPath);
            }
            for (const child of sourceItem.children) {
                await this.recursiveCopy(child, `${destPath}/${child.name}`);
            }
        }
    }

    async pasteClipboard() {
        if (!this.plugin.clipboard || this.plugin.clipboard.paths.length === 0) return;
        const { action, paths } = this.plugin.clipboard;
        const destDir = this.currentPath;

        new Notice(`Pasting ${paths.length} item(s)...`);

        for (const sourcePath of paths) {
            const item = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!item) continue;

            const targetName = item.name;
            const newPath = destDir ? `${destDir}/${targetName}` : targetName;

            if (action === "cut") {
                if (sourcePath !== newPath) {
                    try {
                        if (item instanceof TFolder) {
                            await this.mergeMoveFolder(item, newPath);
                        } else {
                            const uniquePath = await this.getUniqueDestinationPath(destDir, item.name);
                            await this.app.fileManager.renameFile(item, uniquePath);
                        }
                    } catch (err) {
                        new Notice(`Move failed: ${err.message}`);
                    }
                }
            } else if (action === "copy") {
                try {
                    await this.recursiveCopy(item, newPath);
                } catch (err) {
                    new Notice(`Copy failed: ${err.message}`);
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
            const item = this.app.vault.getAbstractFileByPath(p);
            if (!item) continue;

            // Prevent dragging a folder inside itself
            if (item instanceof TFolder && (targetFolderPath === p || targetFolderPath.startsWith(p + "/"))) {
                continue;
            }

            const newPath = targetFolderPath ? `${targetFolderPath}/${item.name}` : item.name;
            if (p !== newPath) {
                try {
                    if (item instanceof TFolder) {
                        await this.mergeMoveFolder(item, newPath);
                    } else {
                        const uniquePath = await this.getUniqueDestinationPath(targetFolderPath, item.name);
                        await this.app.fileManager.renameFile(item, uniquePath);
                    }
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

class WindowsExplorerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Confirm before deleting")
            .setDesc("Show a confirmation prompt when deleting files or folders.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.confirmDelete)
                    .onChange(async (value) => {
                        this.plugin.settings.confirmDelete = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}

class WindowsExplorerPlugin extends Plugin {
    async onload() {
        this.clipboard = null;
        this.draggedPaths = [];

        await this.loadSettings();
        this.addSettingTab(new WindowsExplorerSettingTab(this.app, this));

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

    async loadSettings() {
        this.settings = Object.assign({ confirmDelete: true }, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
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

    async openExplorerTab(targetPath = "", splitRight = false) {
        const leaf = splitRight 
            ? this.app.workspace.getLeaf("split", "vertical")
            : this.app.workspace.getLeaf("tab");

        await leaf.setViewState({
            type: VIEW_TYPE_WINDOWS_EXPLORER,
            active: true
        });
        if (leaf.view instanceof WindowsExplorerTabView && targetPath) {
            const segments = targetPath.replace(/^\/+|\/+$/g, "").split("/");
            const seededHistory = [""];
            let accumulated = "";
            for (let i = 0; i < segments.length - 1; i++) {
                accumulated = accumulated ? `${accumulated}/${segments[i]}` : segments[i];
                seededHistory.push(accumulated);
            }
            leaf.view.history = seededHistory;
            leaf.view.forwardHistory = [];
            leaf.view.navigateTo(targetPath, false);
        }
        this.app.workspace.revealLeaf(leaf);
    }
}

module.exports = WindowsExplorerPlugin;
