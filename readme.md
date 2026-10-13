It is AI-Generated. I am not a programmer, but I do understand some code. I generated this for my personal use, but I believe it can benefit other people as well, so I am hosting it.

Features:
1. **Main Area Tab View:** Runs as an interactive tab inside Obsidian's central workspace leaf instead of being confined to the sidebars.
2. **Editable Address Bar & Navigation Toolbar:** Displays the current vault path, supports manual editing with Enter to navigate directly to subdirectories, and includes an Up button (↑) to climb directory levels.
3. **Vault Link Preservation:** All file moves, renames, and organizational changes route through Obsidian's native `fileManager`, automatically updating wikilinks and markdown references across the vault.
4. **Selection Engine:**
    * Single-click selection for individual files and folders.
    * Multi-selection using Ctrl/Cmd + Click.
    * Range selection using Shift + Click.
    * Drag-to-select marquee (rubber-band selection box) on whitespace.
    * Empty space left-clicking to clear current selection.
5. **Keyboard Navigation & Hotkeys:**
    * Up and Down arrow keys to cycle through files and folders (including Shift + Arrows for contiguous selection).
    * Enter to go into folders or open notes in a separate tab.
    * F2 inline renaming.
    * Delete key to send selected files and folders to trash with a confirmation prompt.
    * Quick jump / Typeahead navigation (typing alphanumeric characters automatically jumps focus to matching items).
    * Standard clipboard shortcuts: Ctrl+C (Copy), Ctrl+X (Cut), Ctrl+V (Paste), and Ctrl+A (Select All).
6. **Mouse Navigation Controls:** Integrates dedicated mouse back (Button 3) and mouse forward (Button 4) clicks to traverse folder history.
7. **Breadcrumb & Folder Memory:** Remembers the child folder you just exited when moving up a level, automatically scrolling into view and selecting it.
8. **Global Multi-Tab Clipboard System:**
    * Clipboard operations (Cut, Copy, Paste) are stored globally across the plugin instance.
    * Cut items reflect visual dimming/opacity cues across all open explorer tabs.
    * Pasting duplicated files automatically appends a - Copy suffix to avoid overwriting.
    * Visual notice banners indicate progress and completion for copy, cut, paste, and move actions.
9. **Drag-and-Drop File Operations:**
    * Drag items directly into subfolder rows (with hover/drop target outlines).
    * Drag items onto empty whitespace to move them into the current active directory.
    * Cross-tab drag and drop between two split explorer tabs open side-by-side.
10. **Full Context Menu Integration:**
    * **File/Subfolder Menu:** Right-click menus include Open in new explorer tab (for folders), Cut, Copy, Paste, Rename, Delete, and hook into Obsidian's full native menu suite (Bookmarks, Search, Templater, etc.).
    * **Whitespace Menu:** Right-clicking blank space opens the current folder's actions, enabling direct pasting and triggering Obsidian's native folder menu (New note, New folder, New canvas, New base, Search in folder, templates, etc.).
11. **Auto-Refreshing File Tree:** Real-time listeners hook into vault events (create, delete, rename) to repaint and sync explorer contents when modifications happen elsewhere in the app.
12. **Mobile & Touch Compatibility:** NOT TESTED
    * Touch targets scaled for phones.
    * Single-tap execution on mobile devices for navigating folders and opening files.
    * Full mobile context menu support via long-press gestures.
