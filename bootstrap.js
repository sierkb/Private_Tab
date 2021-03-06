const WINDOW_LOADED = -1;
const WINDOW_CLOSED = -2;

const LOG_PREFIX = "[Private Tab] ";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/PrivateBrowsingUtils.jsm");
this.__defineGetter__("patcher", function() {
	delete this.patcher;
	Components.utils.import("chrome://privatetab/content/patcher.jsm");
	patcher.init("privateTabMod::", _log);
	return patcher;
});

function install(params, reason) {
	try {
		Services.strings.flushBundles(); // https://bugzilla.mozilla.org/show_bug.cgi?id=719376
	}
	catch(e) {
		Components.utils.reportError(e);
	}
}
function uninstall(params, reason) {
}
function startup(params, reason) {
	windowsObserver.init(reason);
}
function shutdown(params, reason) {
	windowsObserver.destroy(reason);
}

var windowsObserver = {
	initialized: false,
	init: function(reason) {
		if(this.initialized)
			return;
		this.initialized = true;

		prefs.init();
		_dbg = prefs.get("debug", false);
		_dbgv = prefs.get("debug.verbose", false);

		this.patchPrivateBrowsingUtils(true);
		this.initHotkeys();
		this.appButtonDontChange = !prefs.get("fixAppButtonWidth");

		this.windows.forEach(function(window) {
			this.initWindow(window, reason);
		}, this);
		Services.ww.registerNotification(this);
		Services.obs.addObserver(this, "sessionstore-state-write", false);
	},
	destroy: function(reason) {
		if(!this.initialized)
			return;
		this.initialized = false;

		if(reason == ADDON_DISABLE || reason == ADDON_UNINSTALL)
			this.askToClosePrivateTabs();

		this.windows.forEach(function(window) {
			this.destroyWindow(window, reason);
		}, this);
		Services.ww.unregisterNotification(this);

		if(reason != APP_SHUTDOWN) {
			// nsISessionStore may save data after our shutdown
			Services.obs.removeObserver(this, "sessionstore-state-write");

			this.unloadStyles();
			this.restoreAppButtonWidth();
			this.patchPrivateBrowsingUtils(false);
		}

		prefs.destroy();
		this._dndPrivateNode = null;
		patcher.destroy();
		Components.utils.unload("chrome://privatetab/content/patcher.jsm");
	},

	observe: function(subject, topic, data) {
		if(topic == "domwindowopened") {
			if(!subject.opener) {
				var aw = Services.ww.activeWindow;
				if(aw && this.isTargetWindow(aw))
					subject.__privateTabOpener = aw;
			}
			subject.addEventListener("load", this, false);
		}
		else if(topic == "domwindowclosed")
			this.destroyWindow(subject, WINDOW_CLOSED);
		else if(topic == "sessionstore-state-write")
			this.filterSession(subject);
	},

	handleEvent: function(e) {
		switch(e.type) {
			case "load":                      this.loadHandler(e);           break;
			case "TabOpen":                   this.tabOpenHandler(e);        break;
			case "SSTabRestoring":            this.tabRestoringHandler(e);   break;
			case "TabSelect":                 this.tabSelectHandler(e);      break;
			case "TabClose":                  this.tabCloseHandler(e);       break;
			case "dragstart":                 this.dragStartHandler(e);      break;
			case "dragend":                   this.dragEndHandler(e);        break;
			case "drop":                      this.dropHandler(e);           break;
			case "popupshowing":              this.popupShowingHandler(e);   break;
			case "command":                   this.commandHandler(e);        break;
			case "click":                     this.clickHandler(e);          break;
			case "keydown":
			case "keypress":                  this.keypressHandler(e);       break;
			case "PrivateTab:PrivateChanged": this.privateChangedHandler(e); break;
			case "SSWindowStateBusy":         this.setWindowBusy(e, true);   break;
			case "SSWindowStateReady":        this.setWindowBusy(e, false);  break;
			case "close":
			case "beforeunload":
			case "SSWindowClosing":           this.windowClosingHandler(e);
		}
	},
	loadHandler: function(e) {
		var window = e.originalTarget.defaultView;
		window.removeEventListener("load", this, false);
		this.initWindow(window, WINDOW_LOADED);
	},
	windowClosingHandler: function(e) {
		var window = e.currentTarget;
		_log("windowClosingHandler() [" + e.type + "]");
		if(e.type == "close" || e.type == "beforeunload") {
			if(e.defaultPrevented) {
				_log(e.type + ": Someone already prevent window closing");
				return;
			}
			if(
				this.hasPrivateTab(window)
				&& this.isLastPrivate(window)
			) {
				if(this.forbidCloseLastPrivate()) {
					e.preventDefault();
					return;
				}
				else {
					var pt = window.privateTab;
					pt._checkLastPrivate = false;
					window.setTimeout(function() { // OK, seems like window stay open
						pt._checkLastPrivate = true;
					}, 50);
				}
			}
			if(!this.isSeaMonkey)
				return; // This is Firefox, will wait for "SSWindowClosing"
		}
		if( //~ todo: this looks like SeaMonkey bug... and may be fixed later
			(this.isSeaMonkey || !this.isPrivateWindow(window))
			&& !prefs.get("savePrivateTabsInSessions")
		) {
			_log(e.type + " => closePrivateTabs()");
			this.closePrivateTabs(window);
		}
		this.destroyWindowClosingHandler(window);
	},
	destroyWindowClosingHandler: function(window) {
		window.removeEventListener("TabClose", this, true);
		window.removeEventListener("TabClose", this, false);
		window.removeEventListener("SSWindowClosing", this, true);
		window.removeEventListener("close", this, false);
		window.removeEventListener("beforeunload", this, false);
	},

	initWindow: function(window, reason) {
		if(reason == WINDOW_LOADED && !this.isTargetWindow(window)) {
			delete window.__privateTabOpener;
			return;
		}

		var gBrowser = window.gBrowser
			|| window.getBrowser(); // For SeaMonkey
		window.privateTab = new API(window);
		var document = window.document;
		this.loadStyles(window);
		this.ensureTitleModifier(document);
		this.patchBrowsers(gBrowser, true);
		this.patchTabIcons(window, true);
		window.setTimeout(function() {
			// We don't need patched functions right after window "load", so it's better to
			// apply patches after any other extensions
			this.patchTabBrowserDND(window, gBrowser, true);
			this.patchBrowserThumbnails(window, true);
			window.setTimeout(function() {
				this.patchWarnAboutClosingWindow(window, true);
			}.bind(this), 50);
		}.bind(this), 0);

		if(reason == WINDOW_LOADED)
			this.inheritWindowState(window);
		Array.forEach(gBrowser.tabs, function(tab) {
			this.setTabState(tab);
		}, this);

		if(this.isPrivateWindow(window)) {
			var root = document.documentElement;
			// We handle window before gBrowserInit.onLoad(), so set "privatebrowsingmode"
			// for fixAppButtonWidth() manually
			if(!PrivateBrowsingUtils.permanentPrivateBrowsing)
				root.setAttribute("privatebrowsingmode", "temporary");
			root.setAttribute(this.privateAttr, "true");
		}
		window.setTimeout(function() {
			// Wait for third-party styles like https://addons.mozilla.org/addon/movable-firefox-button/
			this.appButtonNA = false;
			this.fixAppButtonWidth(document);
			this.updateWindowTitle(gBrowser);
		}.bind(this), 0);

		window.addEventListener("TabOpen", this, false);
		window.addEventListener("SSTabRestoring", this, false);
		window.addEventListener("TabSelect", this, false);
		window.addEventListener("TabClose", this, true);
		window.addEventListener("TabClose", this, false);
		window.addEventListener("dragstart", this, true);
		window.addEventListener("dragend", this, true);
		window.addEventListener("drop", this, true);
		window.addEventListener("PrivateTab:PrivateChanged", this, false);
		window.addEventListener("SSWindowStateBusy", this, true);
		window.addEventListener("SSWindowStateReady", this, true);
		window.addEventListener("SSWindowClosing", this, true);
		window.addEventListener("close", this, false);
		window.addEventListener("beforeunload", this, false);
		if(this.hotkeys)
			window.addEventListener(this.keyEvent, this, this.keyHighPriority);
		window.setTimeout(function() {
			this.initControls(document);
			window.setTimeout(function() {
				this.setHotkeysText(document);
			}.bind(this), 10);
		}.bind(this), 50);
		this.initToolbarButton(document);
	},
	destroyWindow: function(window, reason) {
		window.removeEventListener("load", this, false); // Window can be closed before "load"
		if(reason == WINDOW_CLOSED && !this.isTargetWindow(window))
			return;
		_log("destroyWindow()");
		var gBrowser = window.gBrowser;
		var force = reason != APP_SHUTDOWN && reason != WINDOW_CLOSED;
		var disable = reason == ADDON_DISABLE || reason == ADDON_UNINSTALL;
		if(force) {
			var document = window.document;
			var isPrivateWindow = this.isPrivateWindow(window);
			Array.forEach(gBrowser.tabs, function(tab) {
				tab.removeAttribute(this.privateAttr);
				if(disable && isPrivateWindow ^ this.isPrivateTab(tab)) {
					this.toggleTabPrivate(tab, isPrivateWindow);
					this.fixTabState(tab, false); // Always remove this.privateAttr
				}
			}, this);
			document.documentElement.removeAttribute(this.privateAttr);
			_log("Restore title...");
			if(!isPrivateWindow)
				this.updateWindowTitle(gBrowser, false);
			this.destroyTitleModifier(document);
		}
		this.patchBrowsers(gBrowser, false, !force);
		this.patchTabBrowserDND(window, gBrowser, false, false, !force);
		this.patchWarnAboutClosingWindow(window, false, !force);
		this.patchTabBrowserLoadURI(window, gBrowser, false, false, !force);
		this.patchTabIcons(window, false, !force);
		this.patchBrowserThumbnails(window, false, !force);

		this.unwatchAppButton(window);
		window.removeEventListener("TabOpen", this, false);
		window.removeEventListener("SSTabRestoring", this, false);
		window.removeEventListener("TabSelect", this, false);
		window.removeEventListener("dragstart", this, true);
		window.removeEventListener("dragend", this, true);
		window.removeEventListener("drop", this, true);
		window.removeEventListener(this.keyEvent, this, this.keyHighPriority);
		window.removeEventListener("PrivateTab:PrivateChanged", this, false);
		window.removeEventListener("SSWindowStateBusy", this, true);
		window.removeEventListener("SSWindowStateReady", this, true);
		if(reason != WINDOW_CLOSED) {
			// See resource:///modules/sessionstore/SessionStore.jsm
			// "domwindowclosed" => onClose() => "SSWindowClosing"
			// This may happens after our "domwindowclosed" notification!
			this.destroyWindowClosingHandler(window);
		}
		this.destroyControls(window, force);

		window.privateTab._destroy();
		delete window.privateTab;
	},
	get isSeaMonkey() {
		delete this.isSeaMonkey;
		return this.isSeaMonkey = Services.appinfo.name == "SeaMonkey";
	},
	get windows() {
		var windows = [];
		var ws = Services.wm.getEnumerator(this.isSeaMonkey ? null : "navigator:browser");
		while(ws.hasMoreElements()) {
			var window = ws.getNext();
			if(this.isTargetWindow(window))
				windows.push(window);
		}
		return windows;
	},
	isTargetWindow: function(window) {
		var document = window.document;
		var rs = document.readyState;
		// We can't touch document.documentElement in not yet loaded window!
		// See https://github.com/Infocatcher/Private_Tab/issues/61
		if(rs != "interactive" && rs != "complete")
			return false;
		var winType = document.documentElement.getAttribute("windowtype");
		return winType == "navigator:browser"
			|| winType == "navigator:private"; // SeaMonkey >= 2.19a1 (2013-03-27)
	},
	inheritWindowState: function(window) {
		var args = window.arguments || undefined;
		_log(
			"inheritWindowState():\nwindow.opener: " + window.opener
			+ "\nwindow.__privateTabOpener: " + (window.__privateTabOpener || undefined)
			+ "\nwindow.arguments:\n" + (args && Array.map(args, String).join("\n"))
		);
		var opener = window.opener || window.__privateTabOpener || null;
		delete window.__privateTabOpener;
		var isEmptyWindow = args && !(3 in args);
		if((!opener || isEmptyWindow) && prefs.get("makeNewEmptyWindowsPrivate")) {
			_log("Make new empty window private");
			this.toggleWindowPrivate(window, true);
			return;
		}
		if(!opener || opener.closed || !this.isTargetWindow(opener) || !opener.gBrowser)
			return;
		if(isEmptyWindow) {
			_log("inheritWindowState(): Looks like new empty window, ignore");
			return;
		}
		// See chrome://browser/content/browser.js, nsBrowserAccess.prototype.openURI()
		// newWindow = openDialog(getBrowserURL(), "_blank", "all,dialog=no", url, null, null, null);
		if(
			args && 3 in args && !(4 in args)
			&& args[1] === null
			&& args[2] === null
			&& args[3] === null
			&& !prefs.get("allowOpenExternalLinksInPrivateTabs")
		) {
			_log("Looks like window, opened from external application, ignore");
			return;
		}
		if(this.isPrivateWindow(window)) {
			_log("inheritWindowState(): Ignore already private window");
			return;
		}
		if(!this.isPrivateWindow(opener.content))
			return;
		_log("Inherit private state from current tab of the opener window");
		this.toggleWindowPrivate(window, true);
	},

	prefChanged: function(pName, pVal) {
		if(pName.startsWith("key."))
			this.updateHotkeys(true);
		else if(pName == "keysUseKeydownEvent" || pName == "keysHighPriority")
			this.updateHotkeys();
		else if(pName == "fixAppButtonWidth") {
			this.appButtonDontChange = !pVal;
			this.restoreAppButtonWidth();
			this.windows.forEach(function(window) {
				var document = window.document;
				this.appButtonNA = false;
				if(pVal && !this.appButtonCssURI)
					this.fixAppButtonWidth(document);
				this.updateAppButtonWidth(document, true);
			}, this);
		}
		else if(pName == "dragAndDropTabsBetweenDifferentWindows") {
			this.windows.forEach(function(window) {
				this.patchTabBrowserDND(window, window.gBrowser, pVal, true);
			}, this);
		}
		else if(pName == "makeNewEmptyTabsPrivate") {
			this.windows.forEach(function(window) {
				var document = window.document;
				var menuItem = document.getElementById(this.newTabMenuId);
				if(menuItem)
					menuItem.hidden = pVal;
				var appMenuItem = document.getElementById(this.newTabAppMenuId);
				if(appMenuItem)
					appMenuItem.hidden = pVal;
			}, this);
		}
		else if(pName == "patchDownloads") {
			if(!pVal) this.windows.forEach(function(window) {
				this.updateDownloadPanel(window, this.isPrivateWindow(window));
			}, this);
		}
		else if(pName == "allowOpenExternalLinksInPrivateTabs") {
			this.windows.forEach(function(window) {
				this.patchTabBrowserLoadURI(window, window.gBrowser, !pVal, true);
			}, this);
		}
		else if(pName == "debug")
			_dbg = pVal;
		else if(pName == "debug.verbose")
			_dbgv = pVal;
	},

	pbuFake: function(isPrivate) {
		return Object.create(PrivateBrowsingUtils, {
			isWindowPrivate: {
				value: function privateTabWrapper(window) {
					return isPrivate; //~ todo: check call stack?
				},
				configurable: true,
				enumerable: true
			}
		});
	},
	get pbuFakePrivate() {
		delete this.pbuFakePrivate;
		return this.pbuFakePrivate = this.pbuFake(true);
	},
	get pbuFakeNonPrivate() {
		delete this.pbuFakeNonPrivate;
		return this.pbuFakeNonPrivate = this.pbuFake(false);
	},
	patchTabBrowserDND: function(window, gBrowser, applyPatch, skipCheck, forceDestroy) {
		if(!skipCheck && !prefs.get("dragAndDropTabsBetweenDifferentWindows"))
			return;

		if(applyPatch)
			window._privateTabPrivateBrowsingUtils = PrivateBrowsingUtils;
		else {
			delete window._privateTabPrivateBrowsingUtils;
			delete window.PrivateBrowsingUtils;
			window.PrivateBrowsingUtils = PrivateBrowsingUtils;
		}
		// Note: we can't patch gBrowser.tabContainer.__proto__ nor gBrowser.__proto__:
		// someone may patch instance instead of prototype...
		this.overridePrivateBrowsingUtils(
			window,
			gBrowser.tabContainer,
			"_setEffectAllowedForDataTransfer",
			"gBrowser.tabContainer._setEffectAllowedForDataTransfer",
			true,
			applyPatch,
			forceDestroy
		);
		this.overridePrivateBrowsingUtils(
			window,
			gBrowser,
			"swapBrowsersAndCloseOther",
			"gBrowser.swapBrowsersAndCloseOther",
			true,
			applyPatch,
			forceDestroy
		);
	},
	patchWarnAboutClosingWindow: function(window, applyPatch, forceDestroy) {
		if(this.isSeaMonkey && !("warnAboutClosingWindow" in window))
			return;
		this.overridePrivateBrowsingUtils(
			window,
			window,
			"warnAboutClosingWindow",
			"window.warnAboutClosingWindow",
			false,
			applyPatch,
			forceDestroy
		);
	},
	ensureTabBrowserLoadURIPatched: function(window) {
		if(
			!prefs.get("allowOpenExternalLinksInPrivateTabs")
			&& !patcher.isWrapped(window.gBrowser, "gBrowser.loadURIWithFlags")
		)
			this.patchTabBrowserLoadURI(window, window.gBrowser, true, true);
	},
	patchTabBrowserLoadURI: function(window, gBrowser, applyPatch, skipCheck, forceDestroy) {
		if(!skipCheck && prefs.get("allowOpenExternalLinksInPrivateTabs"))
			return;

		if(applyPatch) {
			var _this = this;
			patcher.wrapFunction(
				gBrowser, "loadURIWithFlags", "gBrowser.loadURIWithFlags",
				function before(aURI, aFlags, aReferrerURI, aCharset, aPostData) {
					if(
						aFlags & Components.interfaces.nsIWebNavigation.LOAD_FLAGS_FROM_EXTERNAL
						&& _this.isPrivateTab(this.selectedTab)
					) {
						_log("loadURIWithFlags() with LOAD_FLAGS_FROM_EXTERNAL flag => open in new tab");
						// See chrome://browser/content/browser.js, nsBrowserAccess.prototype.openURI()
						var tab = this.loadOneTab(aURI || "about:blank", {
							referrerURI: aReferrerURI,
							fromExternal: true,
							inBackground: prefs.getPref("browser.tabs.loadDivertedInBackground")
						});
						return !!tab;
					}
				}
			);
		}
		else {
			patcher.unwrapFunction(gBrowser, "loadURIWithFlags", "gBrowser.loadURIWithFlags", forceDestroy);
		}
	},
	patchBrowsers: function(gBrowser, applyPatch, forceDestroy) {
		var browser = gBrowser.browsers && gBrowser.browsers[0];
		if(!browser) {
			Components.utils.reportError(LOG_PREFIX + "!!! Can't find browser to patch browser.swapDocShells()");
			return;
		}
		var browserProto = Object.getPrototypeOf(browser);
		if(!browserProto || !("swapDocShells" in browserProto)) {
			_log("Can't patch browser: no swapDocShells() method");
			return;
		}
		if(applyPatch) {
			_log("Patch browser.__proto__.swapDocShells() method");
			var _this = this;
			patcher.wrapFunction(
				browserProto, "swapDocShells", "browser.swapDocShells",
				function before(otherBrowser) {
					if("_privateTabIsPrivate" in this) {
						before.isPrivate = this._privateTabIsPrivate;
						delete this._privateTabIsPrivate;
						_log("swapDocShells(): we recently set private state to " + before.isPrivate);
						return;
					}
					try {
						before.isPrivate = otherBrowser.webNavigation
							.QueryInterface(Components.interfaces.nsILoadContext)
							.usePrivateBrowsing;
						_log("swapDocShells(): usePrivateBrowsing: " + before.isPrivate);
					}
					catch(e) {
						Components.utils.reportError(e);
					}
				},
				function after(ret, otherBrowser) {
					var isPrivate = after.before.isPrivate;
					if(isPrivate !== undefined) try {
						this.webNavigation
							.QueryInterface(Components.interfaces.nsILoadContext)
							.usePrivateBrowsing = isPrivate;
						_log("swapDocShells(): set usePrivateBrowsing to " + isPrivate);
						var tab = _this.getTabForBrowser(this);
						tab && _this.dispatchAPIEvent(tab, "PrivateTab:PrivateChanged", isPrivate);
					}
					catch(e) {
						Components.utils.reportError(e);
					}
				}
			);
		}
		else {
			_log("Restore browser.__proto__.swapDocShells() method");
			patcher.unwrapFunction(browserProto, "swapDocShells", "browser.swapDocShells", forceDestroy);
		}
	},
	overridePrivateBrowsingUtils: function(window, obj, meth, key, isPrivate, applyPatch, forceDestroy) {
		if(!obj || !(meth in obj)) {
			Components.utils.reportError(LOG_PREFIX + "!!! Can't find " + key + "()");
			return;
		}
		if(applyPatch) {
			//_log("Override window.PrivateBrowsingUtils for " + key + ", isPrivate: " + isPrivate);
			var pbuOrig = PrivateBrowsingUtils;
			var pbuFake = isPrivate ? this.pbuFakePrivate : this.pbuFakeNonPrivate;
			var restoreTimer = 0;
			patcher.wrapFunction(
				obj, meth, key,
				function before(event) {
					//_log("[patcher] Override PrivateBrowsingUtils.isWindowPrivate()");
					window.PrivateBrowsingUtils = pbuFake;
					window.clearTimeout(restoreTimer);
					restoreTimer = window.setTimeout(function() { // Restore anyway
						if(window.PrivateBrowsingUtils != pbuOrig)
							window.PrivateBrowsingUtils = pbuOrig;
					}, 0);
				},
				function after(ret, event) {
					window.PrivateBrowsingUtils = pbuOrig;
				}
			);
		}
		else {
			patcher.unwrapFunction(obj, meth, key, forceDestroy);
		}
	},
	patchTabIcons: function(window, applyPatch, forceDestroy) {
		this.patchSetIcon(window, applyPatch, forceDestroy);
		if(this.isSeaMonkey)
			this.patchTabSetAttribute(window, applyPatch, forceDestroy);
	},
	patchSetIcon: function(window, applyPatch, forceDestroy) {
		var gBrowser = window.gBrowser;
		var meth = "setIcon";
		var key = "gBrowser." + meth;
		if(applyPatch) {
			var _this = this;
			var restore;
			var restoreTimer = 0;
			patcher.wrapFunction(
				gBrowser, meth, key,
				function before(tab, uri) {
					if(!uri || _this.isPrivateWindow(window))
						return;
					var isPrivate = _this.isPrivateTab(tab);
					if(!isPrivate)
						return;
					_log("[patcher] " + key + "(): isPrivate = " + isPrivate);
					_this._overrideIsPrivate = isPrivate;
					window.clearTimeout(restoreTimer);
					var origSetAttr = Object.getOwnPropertyDescriptor(tab, "setAttribute");
					tab.setAttribute = _this.setTabAttributeProxy;
					if(_this.isSeaMonkey) {
						_log("Override gBrowser.usePrivateBrowsing to " + isPrivate);
						var origUsePrivateBrowsing = Object.getOwnPropertyDescriptor(gBrowser, "usePrivateBrowsing");
						Object.defineProperty(gBrowser, "usePrivateBrowsing", {
							get: function() {
								return isPrivate;
							},
							configurable: true,
							enumerable: true
						});
					}
					restore = function() {
						_this._overrideIsPrivate = undefined;
						if(origSetAttr)
							Object.defineProperty(tab, "setAttribute", origSetAttr);
						else
							delete tab.setAttribute;
						if(_this.isSeaMonkey) {
							if(origUsePrivateBrowsing)
								Object.defineProperty(gBrowser, "usePrivateBrowsing", origUsePrivateBrowsing);
							else
								delete gBrowser.usePrivateBrowsing;
						}
						restore = null;
					};
					restoreTimer = window.setTimeout(restore, 0); // Restore anyway
				},
				function after(ret, tab, uri) {
					if(restore) {
						window.clearTimeout(restoreTimer);
						restore();
					}
				}
			);
		}
		else {
			patcher.unwrapFunction(gBrowser, meth, key, forceDestroy);
		}
	},
	patchTabSetAttribute: function(window, applyPatch, forceDestroy) {
		var tab = window.gBrowser.tabs[0];
		var tabProto = Object.getPrototypeOf(tab);
		if(applyPatch) {
			tabProto._privateTabOrigSetAttribute = Object.getOwnPropertyDescriptor(tabProto, "setAttribute");
			tabProto.setAttribute = this.setTabAttributeProxy;
		}
		else {
			var orig = tabProto._privateTabOrigSetAttribute;
			delete tabProto._privateTabOrigSetAttribute;
			if(orig)
				Object.defineProperty(tabProto, "setAttribute", orig);
			else
				delete tabProto.setAttribute;
		}
		_log("Override tab.setAttribute()");
	},
	setTabAttributeProxy: function(attr, val) {
		var args = arguments;
		if(attr == "image" && val) {
			val += ""; // Convert to string
			if(
				!val.startsWith("moz-anno:favicon:")
				&& privateTabInternal.isPrivateTab(this)
			) {
				args = Array.slice(args);
				try {
					var browser = this.linkedBrowser;
					var doc = browser.contentDocument;
					if(doc instanceof doc.defaultView.ImageDocument) {
						// Will use base64 representation for icons of image documents
						var req = doc.imageRequest;
						if(req && req.image) {
							var img = doc.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "img")[0];
							var canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
							canvas.width = req.image.width;
							canvas.height = req.image.height;
							var ctx = canvas.getContext("2d");
							ctx.drawImage(img, 0, 0);
							args[1] = canvas.toDataURL();
							_log("setTabAttributeProxy() => data:");
						}
					}
				}
				catch(e) {
					Components.utils.reportError(e);
					// Something went wrong, will use cached icon
					args[1] = "moz-anno:favicon:" + val.replace(/[&#]-moz-resolution=\d+,\d+$/, "");
					_log("setTabAttributeProxy() => moz-anno:favicon:");
				}
			}
		}
		return Object.getPrototypeOf(Object.getPrototypeOf(this)).setAttribute.apply(this, args);
	},
	patchBrowserThumbnails: function(window, applyPatch, forceDestroy) {
		if(!("gBrowserThumbnails" in window)) // SeaMonkey?
			return;
		var gBrowserThumbnails = window.gBrowserThumbnails;
		var meth = "_shouldCapture";
		var key = "gBrowserThumbnails." + meth;
		if(applyPatch) {
			var _this = this;
			patcher.wrapFunction(
				gBrowserThumbnails, meth, key,
				function before(browser) {
					if(_this.isPrivateWindow(window.content)) {
						_log(key + ": forbid capturing from " + browser.currentURI.spec.substr(0, 255));
						return { value: false };
					}
					return false;
				}
			);
		}
		else {
			patcher.unwrapFunction(gBrowserThumbnails, meth, key, forceDestroy);
		}
	},

	tabOpenHandler: function(e) {
		var tab = e.originalTarget || e.target;
		if("_privateTabIgnore" in tab) {
			delete tab._privateTabIgnore;
			return;
		}
		_dbgv && _log(e.type + ":\n" + new Error().stack);
		//_dbgv && _log(e.type + ": Components.stack:\n" + JSON.stringify(Components.stack, null, "\t"));
		if(!prefs.get("allowOpenExternalLinksInPrivateTabs")) {
			var err = new Error();
			var curFile = "@" + err.fileName + ":";
			var stack = err.stack.trimRight().split("\n");
			if( // this.handleEvent() => this.tabOpenHandler()
				stack.length == 2 && stack.every(function(line) {
					return line.indexOf(curFile) != -1;
				})
			) {
				_log("Looks like tab, opened from external application, ignore");
				return;
			}
		}
		var gBrowser = this.getTabBrowser(tab);
		var window = tab.ownerDocument.defaultView;
		//~ todo: try get real tab owner!
		var isPrivate;
		if(!this.isEmptyTab(tab, gBrowser)) {
			if(this.isPrivateWindow(window.content))
				isPrivate = true;
			else if(this.isPrivateWindow(window))
				isPrivate = false; // Override browser behavior!
		}
		else if(
			window.privateTab
			&& !window.privateTab._ssWindowBusy
			&& prefs.get("makeNewEmptyTabsPrivate")
		) {
			_log("Make new empty tab private");
			isPrivate = true;
		}
		_log(
			"Tab opened: " + (tab.getAttribute("label") || "").substr(0, 256)
			+ "\nInherit private state: " + isPrivate
		);
		if(isPrivate != undefined)
			this.toggleTabPrivate(tab, isPrivate);
		else {
			window.setTimeout(function() {
				this.setTabState(tab);
			}.bind(this), 0);
		}
	},
	tabRestoringHandler: function(e) {
		var tab = e.originalTarget || e.target;
		if("_privateTabIgnore" in tab) {
			delete tab._privateTabIgnore;
			return;
		}
		_log("Tab restored: " + (tab.getAttribute("label") || "").substr(0, 256));
		var isPrivate = tab.hasAttribute(this.privateAttr);
		if(this.isPrivateTab(tab) != isPrivate) {
			_log("Make restored tab " + (isPrivate ? "private" : "not private"));
			this.toggleTabPrivate(tab, isPrivate);
			if(isPrivate) {
				var window = tab.ownerDocument.defaultView;
				this.onFirstPrivateTab(window, tab);
				window.privateTab._onFirstPrivateTab(window, tab);
			}
		}
	},
	tabCloseHandler: function(e) {
		if(e.eventPhase == e.CAPTURING_PHASE)
			this.checkForLastPrivateTab(e);
		else
			this.cleanupClosedTab(e);
	},
	checkForLastPrivateTab: function(e) {
		// We can't open new private tab in bubbling phase:
		// Error: TypeError: preview is undefined
		// Source file: resource://app/modules/WindowsPreviewPerTab.jsm
		var tab = e.originalTarget || e.target;
		var window = tab.ownerDocument.defaultView;
		if(
			window.privateTab._checkLastPrivate
			&& this.isPrivateTab(tab)
			&& this.isLastPrivate(tab)
		) {
			_log("Closed last private tab");
			if(this.forbidCloseLastPrivate())
				this.openNewPrivateTab(window);
		}
	},
	cleanupClosedTab: function(e) {
		if(prefs.get("rememberClosedPrivateTabs"))
			return;
		var tab = e.originalTarget || e.target;
		if(!this.isPrivateTab(tab))
			return;
		var window = tab.ownerDocument.defaultView;
		_log(
			"Private tab closed: " + (tab.getAttribute("label") || "").substr(0, 256)
			+ "\nTry don't save it in undo close history"
		);
		var silentFail = false;
		if(e.detail) {
			_log("Tab moved to another window");
			silentFail = true;
		}
		else if(tab.hasAttribute("closedownloadtabs-closed")) {
			// https://github.com/Infocatcher/Close_Download_Tabs
			_log('Found "closedownloadtabs-closed" attribute');
			silentFail = true;
		}
		this.forgetClosedTab(window, silentFail);
		if(this.isSeaMonkey)
			window.setTimeout(this.forgetClosedTab.bind(this, window, silentFail, true), 0);
	},
	closePrivateTabs: function(window) {
		var gBrowser = window.gBrowser;
		var tabs = gBrowser.tabs;
		var hasNotPrivate = false;
		for(var i = tabs.length - 1; i >= 0; --i) {
			var tab = tabs[i];
			if(!tab.hasAttribute(this.privateAttr))
				hasNotPrivate = true;
			else {
				if(i == 0 && !hasNotPrivate)
					gBrowser.selectedTab = gBrowser.addTab("about:blank", { skipAnimation: true });
				gBrowser.removeTab(tab, { animate: false });
				_log("closePrivateTabs(): remove tab: " + (tab.getAttribute("label") || "").substr(0, 256));
			}
		}
		return !hasNotPrivate;
	},
	askToClosePrivateTabs: function() {
		var privateTabs = 0;
		this.windows.forEach(function(window) {
			if(this.isPrivateWindow(window))
				return;
			Array.forEach(
				window.gBrowser.tabs,
				function(tab) {
					if(tab.hasAttribute(this.privateAttr))
						++privateTabs;
				},
				this
			);
		}, this);
		_log("askToClosePrivateTabs(): tabs count: " + privateTabs);
		if(!privateTabs)
			return;
		var ps = Services.prompt;
		// https://bugzilla.mozilla.org/show_bug.cgi?id=345067
		// confirmEx always returns 1 if the user closes the window using the close button in the titlebar
		var closeTabs = ps.confirmEx(
			Services.ww.activeWindow,
			this.getLocalized("dialogTitle"),
			this.getLocalized("dialogQuestion").replace("%S", privateTabs),
			  ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_0_DEFAULT,
			this.getLocalized("dialogClose"),
			this.getLocalized("dialogRestore"),
			"",
			null, {}
		) != 1;
		closeTabs && this.windows.forEach(function(window) {
			if(this.isPrivateWindow(window))
				return;
			if(this.closePrivateTabs(window))
				window.setTimeout(window.close, 0);
		}, this);
	},
	forgetClosedTab: function(window, silentFail, _secondTry) {
		var closedTabs = JSON.parse(this.ss.getClosedTabData(window));
		for(var i = 0, l = closedTabs.length; i < l; ++i) {
			var closedTab = closedTabs[i];
			var state = closedTab.state;
			//_log("Found closed tab:\n" + JSON.stringify(state));
			if(
				"attributes" in state
				&& this.privateAttr in state.attributes
			) {
				this.ss.forgetClosedTab(window, i);
				_log("Forget about closed tab #" + i + (_secondTry ? " (workaround for SeaMonkey)" : ""));
				return;
			}
		}
		var msg = "Can't forget about closed tab: tab not found, closed tabs count: " + l;
		if(silentFail)
			_log(msg + ", but all should be OK");
		else
			Components.utils.reportError(LOG_PREFIX + "!!! " + msg);
	},
	filterSession: function(stateData) {
		if(!stateData || !(stateData instanceof Components.interfaces.nsISupportsString))
			return;
		var stateString = stateData.data;
		//_log("filterSession():\n" + stateString);
		if(
			prefs.get("savePrivateTabsInSessions")
			|| stateString.indexOf('"privateTab-isPrivate":"true"') == -1 // Should be faster, than JSON.parse()
		)
			return;
		var state = JSON.parse(stateString);
		var sessionChanged = false;
		state.windows.forEach(function(windowState) {
			if(windowState.isPrivate) // Browser should ignore private windows itself
				return;
			var windowChanged = false;
			var oldSelected = windowState.selected || 1;
			var newSelected;
			var newIndex = 0;
			var tabs = windowState.tabs = windowState.tabs.filter(function(tabState, i) {
				var isPrivate = "attributes" in tabState && this.privateAttr in tabState.attributes;
				if(isPrivate)
					sessionChanged = windowChanged = true;
				else {
					++newIndex;
					if(!newSelected && i + 1 >= oldSelected)
						newSelected = newIndex;
				}
				return !isPrivate;
			}, this);
			if(windowChanged) {
				windowState.selected = newSelected || tabs.length;
				//_log("Correct selected tab: " + oldSelected + " => " + newSelected + " => " + windowState.selected);
			}
			//~ todo: what to do with empty window without tabs ?
		}, this);
		if(!sessionChanged)
			return;
		var newStateString = JSON.stringify(state);
		if(newStateString == stateString)
			return;
		stateData.data = newStateString;
		//_log("Try override session state");
	},
	tabSelectHandler: function(e) {
		var tab = e.originalTarget || e.target;
		var window = tab.ownerDocument.defaultView;
		var browser = tab.linkedBrowser;
		if(
			!browser
			|| !browser.webProgress
			|| browser.webProgress.isLoadingDocument
		) {
			_log("Selected tab not yet loaded, wait");
			window.setTimeout(function() {
				this.updateWindowTitle(window.gBrowser);
			}.bind(this), 0);
		}
		else {
			this.updateWindowTitle(window.gBrowser);
		}
		window.setTimeout(function() {
			// Someone may change "usePrivateBrowsing"...
			// It's good to show real state
			if(tab.parentNode) // Ignore removed tabs
				this.setTabState(tab);
		}.bind(this), 50);
	},
	_dndPrivateNode: null,
	get dndPrivateNode() {
		try { // We can get "can't access dead object" error here
			var node = this._dndPrivateNode;
			if(node.parentNode && node.ownerDocument)
				return node;
		}
		catch(e) {
		}
		return null;
	},
	dragStartHandler: function(e) {
		var window = e.currentTarget;
		var sourceNode = this._dndPrivateNode = this.isPrivateWindow(window.content)
			? e.originalTarget || e.target
			: null;
		sourceNode && _log(e.type + ": mark <" + sourceNode.nodeName + "> " + sourceNode + " node as private");
	},
	dragEndHandler: function(e) {
		this._dndPrivateNode && _log(e.type + " => this._dndPrivateNode = null");
		this._dndPrivateNode = null;
	},
	dropHandler: function(e) {
		var window = e.currentTarget;
		var dt = e.dataTransfer;

		var sourceNode = dt.mozSourceNode || dt.sourceNode;
		if(!sourceNode) {
			_log(e.type + ": missing source node, ignore");
			return;
		}
		if(
			!this.isSeaMonkey
			&& sourceNode instanceof sourceNode.ownerDocument.defaultView.XULElement
			&& this.getTabFromChild(sourceNode)
		) { // Firefox calls browser.swapDocShells()
			_log(e.type + ": ignore tabs drag-and-drop in Firefox");
			return;
		}
		var isPrivateSource = sourceNode == this.dndPrivateNode;
		this._dndPrivateNode = null;
		_log(e.type + ": from " + (isPrivateSource ? "private" : "not private") + " tab");

		var targetTab;
		if(e.view.top == window) {
			var trg = e.originalTarget || e.target;
			targetTab = this.getTabFromChild(trg);
			if(
				sourceNode instanceof window.XULElement
				&& this.getTabFromChild(sourceNode)
				&& sourceNode.ownerDocument.defaultView == window
				&& (targetTab || this.getTabBarFromChild(trg))
			) {
				_log(e.type + ": tab was dragged into tab or tab bar in the same window, ignore");
				return;
			}
		}
		else if(e.view.top == window.content) {
			var trg = e.target;
			var cs = trg.ownerDocument.defaultView.getComputedStyle(trg, null);
			var userModify = "userModify" in cs ? cs.userModify : cs.MozUserModify;
			if(userModify == "read-write") {
				_log("Dropped into editable node, ignore");
				return;
			}
			targetTab = window.gBrowser.selectedTab;
		}

		var isPrivateTarget = targetTab
			? this.isPrivateTab(targetTab)
			: this.isPrivateWindow(window);
		_log("Will use target private state (from " + (targetTab ? "tab" : "window") + ")");

		var isPrivate;
		var dndBehavior = prefs.get("dragAndDropBehavior", 0);
		if(dndBehavior == 1) {
			isPrivate = isPrivateSource;
			_log("Will use source private state: " + isPrivateSource);
		}
		else if(dndBehavior == 2) {
			isPrivate = isPrivateTarget;
			_log("Will use target private state: " + isPrivateTarget);
		}
		else {
			isPrivate = isPrivateSource || isPrivateTarget;
			_log("Will use source or target private state: " + isPrivateSource + " || " + isPrivateTarget);
		}

		var origIsPrivate;
		if(targetTab && dndBehavior != 2 && isPrivate != this.isPrivateTab(targetTab)) {
			origIsPrivate = !isPrivate;
			_log(
				"Dropped link may be opened in already existing tab, so make it "
				+ (isPrivate ? "private" : "not private")
			);
			this.toggleTabPrivate(targetTab, isPrivate, true);
		}

		this.waitForTab(window, function(tab) {
			if(!tab) {
				if(!targetTab)
					return;
				tab = targetTab;
			}
			if(origIsPrivate != undefined) {
				if(tab == targetTab) {
					_log("Highlight target tab as " + (isPrivate ? "private" : "not private"));
					this.dispatchAPIEvent(targetTab, "PrivateTab:PrivateChanged", isPrivate);
				}
				else {
					_log("Restore private state of target tab");
					this.toggleTabPrivate(targetTab, origIsPrivate, true);
				}
			}
			tab._privateTabIgnore = true; // We should always set this flag!
			_log(
				"drop: make " + (tab == targetTab ? "current" : "new") + " tab "
				+ (isPrivate ? "private" : "not private")
			);
			// Strange things happens in private windows, so we force set private flag
			if(this.isPrivateTab(tab) != isPrivate || isPrivate)
				this.toggleTabPrivate(tab, isPrivate);
			else
				_log("Already correct private state, ignore");
		}.bind(this));
	},
	popupShowingHandler: function(e) {
		var popup = e.target;
		if(popup != e.currentTarget)
			return;
		var window = popup.ownerDocument.defaultView;
		if(popup.id == "appmenu-popup")
			this.initAppMenu(window, popup);
		else if(popup.id == "contentAreaContextMenu")
			this.updatePageContext(window);
		else if(popup.localName == "tooltip")
			this.updateTabTooltip(window);
		else
			this.updateTabContext(window);
	},
	updatePageContext: function(window) {
		var document = window.document;
		var gContextMenu = window.gContextMenu;
		var noLink = !gContextMenu
			|| (!gContextMenu.onSaveableLink && !gContextMenu.onPlainTextLink);
		var inNewTab = document.getElementById("context-openlinkintab");
		if(
			noLink
			&& gContextMenu && gContextMenu.onMailtoLink
			&& inNewTab && !inNewTab.hidden
		) {
			// See chrome://browser/content/nsContextMenu.js
			// Simple way to inherit
			// var shouldShow = this.onSaveableLink || isMailtoInternal || this.onPlainTextLink;
			noLink = false;
		}
		if(!noLink && !gContextMenu.linkURL)
			noLink = true;
		var mi = document.getElementById(this.contextId);
		mi.hidden = noLink;

		var hideNotPrivate = this.isPrivateWindow(window.content);
		// Hide "Open Link in New Tab/Window" from page context menu on private tabs:
		// we inherit private state, so here should be only "Open Link in New Private Tab/Window"
		var inNewWin = document.getElementById("context-openlink");
		var inNewPrivateWin = document.getElementById("context-openlinkprivate")
			|| document.getElementById("context-openlinkinprivatewindow"); // SeaMonkey 2.19a1
		if(inNewTab && !noLink)
			inNewTab.hidden = hideNotPrivate;
		if(inNewWin && inNewPrivateWin && !noLink)
			inNewWin.hidden = hideNotPrivate || this.isPrivateWindow(window);
	},
	updateTabTooltip: function(window) {
		var document = window.document;
		var tab = document.tooltipNode;
		var hide = !tab || tab.localName != "tab" || !this.isPrivateTab(tab);
		var label = document.getElementById(this.tabTipId);
		if(label)
			label.hidden = hide;
	},
	updateTabContext: function(window) {
		var document = window.document;
		_log("updateTabContext()");
		var tab = this.getContextTab(window);
		var hide = !tab || tab.localName != "tab";
		var mi = document.getElementById(this.tabContextId);
		mi.hidden = hide;
		if(!hide) {
			var check = this.isPrivateTab(tab);
			if(check)
				mi.setAttribute("checked", "true");
			else
				mi.removeAttribute("checked");
			var accel = document.getAnonymousElementByAttribute(mi, "class", "menu-accel-container");
			if(accel)
				accel.hidden = tab != window.gBrowser.selectedTab;
			//mi.disabled = this.isPendingTab(tab);
		}
	},
	commandHandler: function(e) {
		this.handleCommandFromEvent(e, e.shiftKey || e.ctrlKey || e.altKey || e.metaKey);
	},
	clickHandler: function(e) {
		if(e.button == 1 && e.target.getAttribute("disabled") != "true")
			this.handleCommandFromEvent(e, true, true);
	},
	handleCommandFromEvent: function(e, shifted, closeMenus) {
		var trg = e.target;
		var cmd = trg.getAttribute(this.cmdAttr);
		var window = trg.ownerDocument.defaultView;
		this.handleCommand(window, cmd, shifted, closeMenus, e);
		if(closeMenus) {
			window.closeMenus(trg);
			var mp = trg.parentNode;
			if("triggerNode" in mp) {
				var tn = mp._privateTabTriggerNode || mp.triggerNode;
				tn && window.closeMenus(tn);
			}
		}
	},
	handleCommand: function(window, cmd, shifted, closeMenus, e) {
		_log("handleCommand: " + cmd);
		if(cmd == "openInNewPrivateTab")
			this.openInNewPrivateTab(window, shifted);
		else if(cmd == "openNewPrivateTab")
			this.openNewPrivateTab(window);
		else if(cmd == "toggleTabPrivate")
			this.toggleContextTabPrivate(window);
		else if(cmd == "openPlacesInNewPrivateTab")
			this.openPlaceInNewPrivateTab(window, shifted, e);
		else {
			var caller = Components.stack.caller;
			throw new Error(LOG_PREFIX + 'Unknown command: "' + cmd + '"', caller.filename, caller.lineNumber);
		}
	},
	keypressHandler: function(e) {
		var keys = this.hotkeys;
		for(var kId in keys) {
			var k = keys[kId];
			if(
				e.ctrlKey == k.ctrlKey
				&& e.altKey == k.altKey
				&& e.shiftKey == k.shiftKey
				&& e.metaKey == k.metaKey
				&& e.getModifierState("OS") == k.osKey
				&& (
					k.char && String.fromCharCode(e.charCode || e.keyCode).toUpperCase() == k.char
					|| k.code && e.keyCode == k.code
				)
			) {
				var phase;
				switch(e.eventPhase) {
					case e.CAPTURING_PHASE: phase = "CAPTURING_PHASE"; break;
					case e.AT_TARGET:       phase = "AT_TARGET";       break;
					case e.BUBBLING_PHASE:  phase = "BUBBLING_PHASE";
				}
				_log(e.type + ": matched key: " + kId + ", phase: " + phase);
				if(e.defaultPrevented && !prefs.get("keysIgnoreDefaultPrevented")) {
					_log(e.type + ": event.defaultPrevented => do nothing");
					return;
				}
				var window = e.currentTarget;
				if(k.forbidInTextFields) {
					var fe = window.document.commandDispatcher.focusedElement;
					if(
						fe && (
							fe instanceof window.HTMLInputElement
							|| fe instanceof window.HTMLTextAreaElement
						)
					) {
						try { // Throws on not-text input elements
							if(typeof fe.selectionStart == "number") {
								_log("Don't use single char hotkey in text field");
								return;
							}
						}
						catch(e) {
						}
					}
				}
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				this.handleCommand(window, kId.replace(/#.*$/, ""));
			}
		}
	},
	privateChangedHandler: function(e) {
		var tab = e.originalTarget || e.target;
		var isPrivate = e.detail == 1;
		this.setTabState(tab, isPrivate);
		var gBrowser = tab.ownerDocument.defaultView.gBrowser;
		if(gBrowser.selectedTab == tab) {
			_log(e.type + " + gBrowser.selectedTab == tab => updateWindowTitle()");
			this.updateWindowTitle(gBrowser, isPrivate);
		}
	},
	setWindowBusy: function(e, busy) {
		_log("setWindowBusy(): " + busy);
		var window = e.currentTarget;
		var privateTab = window.privateTab;
		privateTab._ssWindowBusy = busy;
		if(this.isSeaMonkey) {
			window.clearTimeout(privateTab._ssWindowBusyRestoreTimer);
			if(busy) {
				privateTab._ssWindowBusyRestoreTimer = window.setTimeout(function() {
					_log("setWindowBusy(): false (workaround for SeaMonkey)");
					privateTab._ssWindowBusy = false;
				}, 0);
			}
		}
	},

	openInNewPrivateTab: function(window, toggleInBackground) {
		// Based on nsContextMenu.prototype.openLinkInTab()
		var gContextMenu = window.gContextMenu;
		var uri = gContextMenu.linkURL;
		var doc = gContextMenu.target.ownerDocument;
		window.urlSecurityCheck(uri, doc.nodePrincipal);
		this.openURIInNewPrivateTab(window, uri, doc, {
			toggleInBackground: toggleInBackground
		});
	},
	openPlaceInNewPrivateTab: function(window, toggleInBackground, e) {
		var mi = e && e.target;
		if(!mi)
			return;
		_log("openPlaceInNewPrivateTab(): " + mi.nodeName + " " + mi.getAttribute("label"));
		var placesContext = mi.parentNode;
		var view = placesContext._view;
		var node = view.selectedNode;
		var top = this.getTopWindow(window.top);
		try {
			if(!window.PlacesUIUtils.checkURLSecurity(node, top))
				return;
		}
		catch(e) {
			Components.utils.reportError(e);
		}
		var loadInBackgroundPref = "browser.tabs.loadBookmarksInBackground";
		this.openURIInNewPrivateTab(top, node.uri, null, {
			toggleInBackground: toggleInBackground,
			loadInBackgroundPref: prefs.getPref(loadInBackgroundPref) != undefined && loadInBackgroundPref,
			openAsChild: window.top == top.content
		});
	},
	openURIInNewPrivateTab: function(window, uri, sourceDocument, options) {
		var toggleInBackground = "toggleInBackground" in options && options.toggleInBackground;
		var loadInBackgroundPref = options.loadInBackgroundPref || "browser.tabs.loadInBackground";
		var openAsChild = "openAsChild" in options ? options.openAsChild : true;

		var relatedToCurrent;
		var w = this.getNotPopupWindow(window);
		if(w && w != window) {
			relatedToCurrent = openAsChild = false;
			w.setTimeout(w.focus, 0);
			window = w;
		}
		var gBrowser = window.gBrowser;

		if(openAsChild) {
			// http://piro.sakura.ne.jp/xul/_treestyletab.html.en#api
			if("TreeStyleTabService" in window)
				window.TreeStyleTabService.readyToOpenChildTab(gBrowser.selectedTab);
			// Tab Kit https://addons.mozilla.org/firefox/addon/tab-kit/
			// TabKit 2nd Edition https://addons.mozilla.org/firefox/addon/tabkit-2nd-edition/
			if("tabkit" in window)
				window.tabkit.addingTab("related");
		}

		var referer = null;
		if(sourceDocument) {
			var sendReferer = prefs.get("sendRefererHeader");
			if(
				sendReferer > 0
				&& (sendReferer > 1 || this.isPrivateWindow(sourceDocument.defaultView))
			)
				referer = sourceDocument.documentURIObject;
		}

		this.readyToOpenPrivateTab(window);
		var tab = gBrowser.addTab(uri, {
			referrerURI: referer,
			charset: sourceDocument ? sourceDocument.characterSet : null,
			ownerTab: gBrowser.selectedTab,
			relatedToCurrent: relatedToCurrent
		});

		var inBackground = prefs.get("loadInBackground");
		if(inBackground == -1)
			inBackground = prefs.getPref(loadInBackgroundPref);
		if(toggleInBackground)
			inBackground = !inBackground;
		if(!inBackground)
			gBrowser.selectedTab = tab;

		if(openAsChild && "tabkit" in window)
			window.tabkit.addingTabOver();

		this.dispatchAPIEvent(tab, "PrivateTab:OpenInNewTab", openAsChild);
		return tab;
	},
	openNewPrivateTab: function(window) {
		var w = this.getNotPopupWindow(window);
		if(w && w != window) {
			w.setTimeout(w.focus, 0);
			window = w;
		}
		var gBrowser = window.gBrowser;
		this.readyToOpenPrivateTab(window);
		var tab = gBrowser.selectedTab = gBrowser.addTab(window.BROWSER_NEW_TAB_URL);
		if("focusAndSelectUrlBar" in window)
			window.setTimeout(window.focusAndSelectUrlBar, 0);
		else if("WindowFocusTimerCallback" in window) // SeaMonkey
			window.setTimeout(window.WindowFocusTimerCallback, 0, window.gURLBar);

		this.dispatchAPIEvent(tab, "PrivateTab:OpenNewTab");
		return tab;
	},
	readyToOpenPrivateTab: function(window) {
		this.waitForTab(window, function(tab) {
			if(!tab)
				return;
			tab._privateTabIgnore = true;
			this.toggleTabPrivate(tab, true);
		}.bind(this));
	},
	waitForTab: function(window, callback) {
		_log("waitForTab()");
		function tabOpen(e) {
			window.removeEventListener("TabOpen", tabOpen, true);
			window.clearTimeout(timer);
			var tab = e.originalTarget || e.target;
			_log("waitForTab(): opened tab");
			callback(tab);
		}
		window.addEventListener("TabOpen", tabOpen, true);
		var timer = window.setTimeout(function() {
			window.removeEventListener("TabOpen", tabOpen, true);
			_log("waitForTab(): nothing");
			callback(null);
		}, 0);
	},
	getNotPopupWindow: function(window) {
		if(window.toolbar.visible)
			return window;
		if(prefs.get("dontUseTabsInPopupWindows")) try {
			Components.utils.import("resource:///modules/RecentWindow.jsm");
			return RecentWindow.getMostRecentBrowserWindow({
				allowPopups: false
			});
		}
		catch(e) {
		}
		return null;
	},
	getContextTab: function(window, checkMenuVisibility) {
		var cm, contextTab;
		if("TabContextMenu" in window)
			contextTab = window.TabContextMenu.contextTab || null;
		if(contextTab === undefined || checkMenuVisibility) {
			cm = this.getTabContextMenu(window.document);
			if(checkMenuVisibility && cm.state == "closed")
				return null;
		}
		return contextTab || cm && cm.triggerNode && window.gBrowser.mContextTab;
	},
	toggleContextTabPrivate: function(window) {
		var tab = this.getContextTab(window, true)
			|| window.gBrowser.selectedTab; // For hotkey
		var isPrivate = this.toggleTabPrivate(tab);
		if(this.isPendingTab(tab))
			this.fixTabState(tab, isPrivate);
		else if(prefs.get("toggleTabPrivateAutoReload")) {
			var browser = tab.linkedBrowser;
			if(!browser.webProgress.isLoadingDocument)
				tab.linkedBrowser.reload();
		}
		if(tab == this.getTabBrowser(tab).selectedTab) {
			this.updateTabContext(window);
			this.updateTabTooltip(window);
			if("TabScope" in window && "_updateTitle" in window.TabScope && window.TabScope._tab)
				window.TabScope._updateTitle();
		}
	},

	cmdAttr: "privateTab-command",
	toolbarButtonId: "privateTab-toolbar-openNewPrivateTab",
	contextId: "privateTab-context-openInNewPrivateTab",
	tabContextId: "privateTab-tabContext-toggleTabPrivate",
	newTabMenuId: "privateTab-menu-openNewPrivateTab",
	newTabAppMenuId: "privateTab-appMenu-openNewPrivateTab",
	tabTipId: "privateTab-tooltip-isPrivateTabLabel",
	tabScopeTipId: "privateTab-tabScope-isPrivateTabLabel",
	placesContextId: "privateTab-places-openInNewPrivateTab",
	getToolbox: function(window) {
		return window.gNavToolbox || window.getNavToolbox();
	},
	getPaletteButton: function(window) {
		var btns = this.getToolbox(window)
			.palette
			.getElementsByAttribute("id", this.toolbarButtonId);
		return btns.length && btns[0];
	},
	getTabContextMenu: function(document) {
		return document.getElementById("tabContextMenu")
			|| document.getAnonymousElementByAttribute(
				document.defaultView.gBrowser,
				"anonid",
				"tabContextMenu"
			);
	},
	getTabTooltip: function(document) {
		var tabTip = document.getElementById("tabbrowser-tab-tooltip");
		if(!tabTip) { // SeaMonkey
			var gBrowser = document.defaultView.gBrowser;
			var tabStrip = document.getAnonymousElementByAttribute(gBrowser, "anonid", "strip");
			if(tabStrip && tabStrip.firstChild && tabStrip.firstChild.localName == "tooltip")
				tabTip = tabStrip.firstChild;
		}
		return tabTip;
	},
	initToolbarButton: function(document) {
		var tbId = this.toolbarButtonId;
		var tb = this.createNode(document, "toolbarbutton", tbId, {
			id: tbId,
			"class": "toolbarbutton-1 chromeclass-toolbar-additional",
			removable: "true",
			label: this.getLocalized("openNewPrivateTab"),
			tooltiptext: this.getLocalized("openNewPrivateTabTip"),
			"privateTab-command": "openNewPrivateTab"
		});

		var toolbars = document.getElementsByTagName("toolbar");
		function isSep(id) {
			return id == "separator" || id == "spring" || id == "spacer";
		}
		for(var i = 0, l = toolbars.length; i < l; ++i) {
			var toolbar = toolbars[i];
			var ids = (toolbar.getAttribute("currentset") || "").split(",");
			var pos = ids.indexOf(tbId);
			if(pos == -1)
				continue;
			_log(
				'Found toolbar with "' + tbId + '" in currentset, toolbar: '
				+ "#" + toolbar.id + ", name: " + toolbar.getAttribute("toolbarname")
			);

			var insPos = null;
			var hasSeps = false;
			for(var j = pos + 1, idsCount = ids.length; j < idsCount; ++j) {
				var id = ids[j];
				if(isSep(id)) {
					hasSeps = true;
					continue;
				}
				var nodes = toolbar.getElementsByAttribute("id", id);
				var node = nodes.length && nodes[0];
				if(!node)
					continue;
				insPos = node;
				_log("Found existing node on toolbar: #" + id);
				if(hasSeps) for(var k = j - 1; k > pos; --k) {
					var id = ids[k];
					if(!isSep(id)) // This node doesn't exist on toolbar: we checked it early
						continue;
					for(var prev = insPos.previousSibling; prev; prev = prev.previousSibling) {
						var ln = prev.localName || "";
						if(ln.startsWith("toolbar") && isSep(ln.substr(7))) {
							if(ln == "toolbar" + id)
								insPos = prev;
							break;
						}
						if(prev.id && prev.getAttribute("skipintoolbarset") != "true")
							break;
					}
				}
				break;
			}
			toolbar.insertBefore(tb, insPos);
			_log("Insert toolbar button " + (insPos ? "before " + insPos.id : "at the end"));
			return;
		}

		this.getToolbox(document.defaultView)
			.palette
			.appendChild(tb);
	},
	initControls: function(document) {
		var window = document.defaultView;

		var contentContext = document.getElementById("contentAreaContextMenu");
		contentContext.addEventListener("popupshowing", this, false);

		var contextItem = this.createNode(document, "menuitem", this.contextId, {
			label:     this.getLocalized("openInNewPrivateTab"),
			accesskey: this.getLocalized("openInNewPrivateTabAccesskey"),
			"privateTab-command": "openInNewPrivateTab"
		});
		this.insertNode(contextItem, contentContext, ["#context-openlinkintab"]);

		var menuItemParent = document.getElementById("menu_NewPopup") // SeaMonkey
			|| document.getElementById("menu_FilePopup");
		var shortLabel = menuItemParent.id == "menu_NewPopup" ? "Short" : "";
		var menuItem = this.createNode(document, "menuitem", this.newTabMenuId, {
			label:     this.getLocalized("openNewPrivateTab" + shortLabel),
			accesskey: this.getLocalized("openNewPrivateTab" + shortLabel + "Accesskey"),
			"privateTab-command": "openNewPrivateTab"
		});
		if(prefs.get("makeNewEmptyTabsPrivate"))
			menuItem.hidden = true;
		if(PrivateBrowsingUtils.permanentPrivateBrowsing)
			menuItem.collapsed = true;
		this.insertNode(menuItem, menuItemParent, ["#menu_newNavigatorTab"]);

		// We can't do 'document.getElementById("appmenu_newPrivateWindow")' while App menu was never open:
		// this (somehow) breaks binding for .menuitem-iconic-tooltip class
		var appMenuPopup = document.getElementById("appmenu-popup");
		var appMenuItemParent = document.getElementById("appmenuPrimaryPane");
		if(appMenuPopup && appMenuItemParent) {
			// So will wait for "popupshowing" to move menuitem (and do other initializations)
			appMenuPopup.addEventListener("popupshowing", this, false);

			var appMenuItem = this.createNode(document, "menuitem", this.newTabAppMenuId, {
				label: this.getLocalized("openNewPrivateTab"),
				class: "menuitem-iconic",
				"privateTab-command": "openNewPrivateTab"
			});
			if(prefs.get("makeNewEmptyTabsPrivate"))
				appMenuItem.hidden = true;
			appMenuItem._privateTabPreviousSibling = appMenuItemParent.lastChild;
			appMenuItemParent.appendChild(appMenuItem);
		}

		var tabContext = this.getTabContextMenu(document);
		_log("tabContext: " + tabContext);
		tabContext.addEventListener("popupshowing", this, false);
		var tabContextItem = this.createNode(document, "menuitem", this.tabContextId, {
			label:     this.getLocalized("privateTab"),
			accesskey: this.getLocalized("privateTabAccesskey"),
			type: "checkbox",
			"privateTab-command": "toggleTabPrivate"
		});
		this.insertNode(tabContextItem, tabContext, ["#context_unpinTab", '[tbattr="tabbrowser-undoclosetab"]']);

		var tabTip = this.getTabTooltip(document);
		if(tabTip) {
			tabTip.addEventListener("popupshowing", this, false);
			var tabTipLabel = document.createElement("label");
			tabTipLabel.id = this.tabTipId;
			tabTipLabel.className = "tooltip-label";
			tabTipLabel.setAttribute("value", this.getLocalized("privateTabTip"));
			tabTipLabel.setAttribute("privateTab-command", "<nothing>");
			tabTipLabel.hidden = true;
			tabTip.insertBefore(
				tabTipLabel,
				tabTip.firstChild != tabTip.lastChild ? tabTip.lastChild : null
			);

			var tabScope = document.getElementById("tabscope-popup");
			if(tabScope && "TabScope" in window && "_updateTitle" in window.TabScope) {
				var tsTipLabel = tabTipLabel.cloneNode(true);
				tsTipLabel.id = this.tabScopeTipId;
				tabScope.appendChild(tsTipLabel);
				var _this = this;
				patcher.wrapFunction(
					window.TabScope, "_updateTitle", "TabScope._updateTitle",
					function before() {
						tsTipLabel.hidden = !_this.isPrivateTab(this._tab);
					}
				);
			}
		}

		window.addEventListener("popupshowing", this.initPlacesContext, true);
	},
	initAppMenu: function(window, popup) {
		_log("initAppMenu()");
		popup.removeEventListener("popupshowing", this, false);

		var document = window.document;
		var appMenuItem = document.getElementById(this.newTabAppMenuId);
		if(!appMenuItem || appMenuItem.hasAttribute("privateTab-initialized")) {
			Components.utils.reportError(
				LOG_PREFIX + "#" + this.newTabAppMenuId + " not found or already initialized"
			);
			return;
		}
		appMenuItem.setAttribute("privateTab-initialized", "true");
		var newPrivateWin = document.getElementById("appmenu_newPrivateWindow");
		if(newPrivateWin) {
			appMenuItem.className = newPrivateWin.className; // menuitem-iconic menuitem-iconic-tooltip
			if(newPrivateWin.hidden) // Permanent private browsing?
				appMenuItem.collapsed = true;
			var s = window.getComputedStyle(newPrivateWin, null);
			var icon = s.listStyleImage;
			if(icon && icon != "none") {
				appMenuItem.style.listStyleImage = icon;
				appMenuItem.style.MozImageRegion = s.MozImageRegion;
			}
		}
		var ps = appMenuItem._privateTabPreviousSibling;
		delete appMenuItem._privateTabPreviousSibling;
		if(ps != appMenuItem.previousSibling) {
			_log("#" + this.newTabAppMenuId + " was moved (Personal Menu or something similar?), ignore");
			return;
		}
		newPrivateWin && this.insertNode(appMenuItem, appMenuItem.parentNode, [newPrivateWin]);
	},
	get initPlacesContext() {
		delete this.initPlacesContext;
		return this.initPlacesContext = this._initPlacesContext.bind(this);
	},
	_initPlacesContext: function(e) {
		var mp = e.originalTarget || e.target;
		if(mp.id != "placesContext")
			return;

		var nodes = mp.getElementsByAttribute("id", this.placesContextId);
		var placesItem = nodes.length && nodes[0];
		placesItem && placesItem.parentNode.removeChild(placesItem);

		var document = mp.ownerDocument;
		placesItem = this.createNode(document, "menuitem", this.placesContextId, {
			label:     this.getLocalized("openPlacesInNewPrivateTab"),
			accesskey: this.getLocalized("openPlacesInNewPrivateTabAccesskey"),
			selection: "link",
			selectiontype: "single",
			"privateTab-command": "openPlacesInNewPrivateTab"
		});
		var inNewTab = mp.getElementsByAttribute("id", "placesContext_open:newtab")[0];
		this.insertNode(placesItem, mp, [inNewTab]);

		var waitForTab = function(e) {
			var trg = e.target;
			_log(e.type + ": " + trg.nodeName + "#" + trg.id);
			if(trg != inNewTab && (!trg.id || trg.id != inNewTab.getAttribute("command")))
				return;
			var top = this.getTopWindow(window.top);
			this.waitForTab(top, function(tab) {
				if(!tab)
					return;
				_log("Wait for tab -> set ignore flag");
				tab._privateTabIgnore = true;
				if(this.isPrivateWindow(top)) {
					_log("Wait for tab -> make tab not private");
					this.toggleTabPrivate(tab, false);
				}
			}.bind(this));
		}.bind(this);
		var window = document.defaultView;
		window.addEventListener("command", waitForTab, true);

		// Easy way to remove added items from all documents :)
		mp._privateTabTriggerNode = mp.triggerNode; // When we handle click, triggerNode are already null
		mp.addEventListener("popuphiding", function destroyPlacesContext(e) {
			if(e.originalTarget != mp)
				return;
			mp.removeEventListener(e.type, destroyPlacesContext, true);
			window.removeEventListener("command", waitForTab, true);
			window.setTimeout(function() {
				mp.removeChild(placesItem);
				delete mp._privateTabTriggerNode;
				_log("Remove item from places context: " + document.documentURI);
			}, 0);
		}, true);
	},
	destroyControls: function(window, force) {
		_log("destroyControls(), force: " + force);
		var document = window.document;
		this.destroyNodes(document, force);
		this.destroyNode(this.getPaletteButton(window), force);

		var contentContext = document.getElementById("contentAreaContextMenu");
		contentContext && contentContext.removeEventListener("popupshowing", this, false);

		var appMenuPopup = document.getElementById("appmenu-popup");
		appMenuPopup && appMenuPopup.removeEventListener("popupshowing", this, false);

		var tabContext = this.getTabContextMenu(document);
		tabContext && tabContext.removeEventListener("popupshowing", this, false);
		if(tabContext && !tabContext.id)
			this.destroyNodes(tabContext, force);

		var tabTip = this.getTabTooltip(document);
		tabTip && tabTip.removeEventListener("popupshowing", this, false);
		var tabTipLabel = document.getElementById(this.tabTipId);
		if(tabTipLabel) // In SeaMonkey we can't simple get anonymous nodes by attribute
			tabTipLabel.parentNode.removeChild(tabTipLabel);
		if("TabScope" in window && "_updateTitle" in window.TabScope)
			patcher.unwrapFunction(window.TabScope, "_updateTitle", "TabScope._updateTitle", !force);

		window.removeEventListener("popupshowing", this.initPlacesContext, true);
	},
	get createNode() {
		delete this.createNode;
		return this.createNode = this._createNode.bind(this);
	},
	_createNode: function(document, nodeName, id, attrs) {
		var mi = document.createElement(nodeName);
		mi.id = id;
		for(var name in attrs)
			mi.setAttribute(name, attrs[name]);
		mi.addEventListener("command", this, false);
		mi.addEventListener("click", this, false);
		return mi;
	},
	insertNode: function(node, parent, insertAfter) {
		if(!parent)
			return;
		var insPos;
		for(var i = 0, l = insertAfter.length; i < l; ++i) {
			var id = insertAfter[i];
			var sibling = typeof id == "string"
				? parent.querySelector(insertAfter[i])
				: id;
			if(sibling && sibling.parentNode == parent) {
				insPos = sibling;
				break;
			}
		}
		parent.insertBefore(node, insPos && insPos.nextSibling);
	},
	destroyNodes: function(parent, force) {
		var nodes = parent.getElementsByAttribute(this.cmdAttr, "*");
		for(var i = nodes.length - 1; i >= 0; --i)
			this.destroyNode(nodes[i], force);
	},
	destroyNode: function(node, force) {
		if(!node)
			return;
		node.removeEventListener("command", this, false);
		node.removeEventListener("click", this, false);
		force && node.parentNode.removeChild(node);
	},

	get keyEvent() {
		return prefs.get("keysUseKeydownEvent")
			? "keydown"
			: "keypress";
	},
	get keyHighPriority() {
		return prefs.get("keysHighPriority");
	},
	hotkeys: null,
	get accelKey() {
		var accelKey = "ctrlKey";
		var ke = Components.interfaces.nsIDOMKeyEvent;
		switch(prefs.getPref("ui.key.accelKey")) {
			case ke.DOM_VK_ALT:  accelKey = "altKey";  break;
			case ke.DOM_VK_META: accelKey = "metaKey";
		}
		delete this.accelKey;
		return this.accelKey = accelKey;
	},
	initHotkeys: function() {
		_log("initHotkeys()");
		var hasKeys = false;
		var keys = { __proto__: null };
		function getVKChar(vk) {
			var tmp = {};
			Services.scriptloader.loadSubScript("chrome://privatetab/content/virtualKeyCodes.js", tmp);
			getVKChar = tmp.getVKChar;
			return getVKChar(vk);
		}
		function initHotkey(kId) {
			var keyStr = prefs.get("key." + kId);
			_log("initHotkey: " + kId + " = " + keyStr);
			if(!keyStr)
				return;
			hasKeys = true;
			var k = keys[kId] = {
				ctrlKey:  false,
				altKey:   false,
				shiftKey: false,
				metaKey:  false,
				osKey:    false,
				char: null,
				code: null,
				_key: null,
				_keyCode: null,
				_modifiers: null,
				__proto__: null
			};
			var tokens = keyStr.split(" ");
			var key = tokens.pop() || " ";
			if(key.length == 1) {
				k.char = key.toUpperCase();
				k._key = key;
			}
			else { // VK_*
				k.code = Components.interfaces.nsIDOMKeyEvent["DOM_" + key];
				var chr = getVKChar(key);
				if(chr)
					k._key = chr;
				else
					k._keyCode = key;
			}
			k._modifiers = tokens.join(",");
			tokens.forEach(function(token) {
				switch(token) {
					case "control": k.ctrlKey  = true;       break;
					case "alt":     k.altKey   = true;       break;
					case "shift":   k.shiftKey = true;       break;
					case "meta":    k.metaKey  = true;       break;
					case "os":      k.osKey    = true;       break;
					case "accel":   k[this.accelKey] = true;
				}
			}, this);
			k.forbidInTextFields = k.char && !k.ctrlKey && !k.altKey && !k.metaKey || false;
		}
		Services.prefs.getBranch(prefs.ns + "key.")
			.getChildList("", {})
			.forEach(initHotkey, this);
		this.hotkeys = hasKeys ? keys : null;
		_log("Keys:\n" + JSON.stringify(keys, null, "\t"));
	},
	getHotkeysNodes: function(document, attr) {
		var nodes = Array.slice(document.getElementsByAttribute(this.cmdAttr, attr));
		var tabContext = this.getTabContextMenu(document);
		if(tabContext && !tabContext.id)
			nodes.push.apply(nodes, Array.slice(tabContext.getElementsByAttribute(this.cmdAttr, attr)));
		return nodes;
	},
	keyInTooltip: function(node) {
		var cl = node.classList;
		return cl.contains("menuitem-tooltip") || cl.contains("menuitem-iconic-tooltip");
	},
	setHotkeysText: function(document) {
		_log("setHotkeysText(): " + document.title);

		const keysetId = "privateTab-keyset";
		var keyset = document.getElementById(keysetId);
		keyset && keyset.parentNode.removeChild(keyset);

		var keys = this.hotkeys;
		if(!keys)
			return;

		keyset = document.createElement("keyset");
		keyset.id = keysetId;
		keyset.setAttribute("privateTab-command", "<nothing>");
		document.documentElement.appendChild(keyset);
		var uid = "-" + Date.now();
		for(var kId in keys) {
			var k = keys[kId];
			var id = "privateTab-key-" + kId + uid;
			var key = document.createElement("key");
			key.setAttribute("id", id);
			k._key       && key.setAttribute("key",       k._key);
			k._keyCode   && key.setAttribute("keycode",   k._keyCode);
			k._modifiers && key.setAttribute("modifiers", k._modifiers);
			keyset.appendChild(key);
			this.getHotkeysNodes(document, kId).forEach(function(node) {
				_log("setHotkeysText(): Update #" + node.id);
				node.removeAttribute("acceltext");
				node.setAttribute("key", id);
				if(this.keyInTooltip(node)) {
					var cn = node.className;
					var cl = node.classList;
					cl.remove("menuitem-tooltip");
					cl.remove("menuitem-iconic-tooltip");
					node.offsetHeight; // Ensure binding changed
					document.defaultView.setTimeout(function() {
						node.className = cn;
					}, 50);
				}
			}, this);
		}
	},
	updateHotkeys: function(updateAll) {
		_log("updateHotkeys(" + (updateAll || "") + ")");
		updateAll && this.initHotkeys();
		var hasHotkeys = !!this.hotkeys;
		var keyEvent = this.keyEvent;
		var keyHighPriority = this.keyHighPriority;
		this.windows.forEach(function(window) {
			window.removeEventListener("keydown", this, true);
			window.removeEventListener("keydown", this, false);
			window.removeEventListener("keypress", this, true);
			window.removeEventListener("keypress", this, false);
			hasHotkeys && window.addEventListener(keyEvent, this, keyHighPriority);
			if(!updateAll)
				return;
			var document = window.document;
			this.getHotkeysNodes(document, "*").forEach(function(node) {
				node.removeAttribute("key");
				node.removeAttribute("acceltext");
				if(this.keyInTooltip(node))
					node.removeAttribute("tooltiptext");
			}, this);
			hasHotkeys && this.setHotkeysText(document);
		}, this);
	},

	isEmptyTab: function(tab, gBrowser) {
		// See "addTab" method in chrome://browser/content/tabbrowser.xml
		var tabLabel = tab.getAttribute("label") || "";
		if(
			!tabLabel
			|| tabLabel == "undefined"
			|| tabLabel == "about:blank"
			|| tabLabel == "chrome://fvd.speeddial/content/fvd_about_blank.html"
			|| tabLabel == "chrome://speeddial/content/speeddial.xul"
			|| tabLabel == "chrome://superstart/content/index.html"
		)
			return true;
		if(/^\w+:\S*$/.test(tabLabel))
			return false;
		// We should check tab label for SeaMonkey and old Firefox
		var emptyTabLabel = this.getTabBrowserString("tabs.emptyTabTitle", gBrowser)
			|| this.getTabBrowserString("tabs.untitled", gBrowser);
		return tabLabel == emptyTabLabel;
	},
	getTabBrowserString: function(id, gBrowser) {
		try {
			return gBrowser.mStringBundle.getString(id);
		}
		catch(e) {
		}
		return undefined;
	},
	setTabState: function(tab, isPrivate) {
		if(isPrivate === undefined)
			isPrivate = this.isPrivateTab(tab);
		if(!isPrivate ^ tab.hasAttribute(this.privateAttr))
			return;
		if(isPrivate) {
			tab.setAttribute(this.privateAttr, "true");
			var window = tab.ownerDocument.defaultView;
			this.onFirstPrivateTab(window, tab);
			window.privateTab._onFirstPrivateTab(window, tab);
		}
		else {
			tab.removeAttribute(this.privateAttr);
		}
	},
	onFirstPrivateTab: function(window, tab) {
		this.onFirstPrivateTab = function() {};
		_log("First private tab");
		window.setTimeout(function() {
			this.ss.persistTabAttribute(this.privateAttr);
		}.bind(this), 0);
	},
	fixTabState: function(tab, isPrivate) {
		if(!this.isPendingTab(tab) || !prefs.get("workaroundForPendingTabs"))
			return;
		if(isPrivate === undefined)
			isPrivate = this.isPrivateTab(tab);
		_log("Workaround: manually update session state of pending tab");
		try {
			var ssData = JSON.parse(this.ss.getTabState(tab));
			//_log("Before:\n" + JSON.stringify(ssData, null, "\t"));
			var hasAttrs = "attributes" in ssData;
			if(isPrivate) {
				if(!hasAttrs)
					ssData.attributes = {};
				ssData.attributes[this.privateAttr] = "true";
			}
			else if(hasAttrs) {
				delete ssData.attributes[this.privateAttr];
			}
			//_log("After:\n" + JSON.stringify(ssData, null, "\t"));
			tab._privateTabIgnore = true;
			this.ss.setTabState(tab, JSON.stringify(ssData));
		}
		catch(e) {
			Components.utils.reportError(e);
		}
	},
	dispatchAPIEvent: function(target, eventType, eventDetail) {
		var document = target.ownerDocument || target;
		if(eventDetail === undefined) {
			var evt = document.createEvent("Events");
			evt.initEvent(eventType, true, false);
		}
		else {
			var evt = document.createEvent("UIEvent");
			evt.initUIEvent(eventType, true, false, document.defaultView, +eventDetail);
		}
		target.dispatchEvent(evt);
	},
	toggleTabPrivate: function(tab, isPrivate, _silent) {
		var privacyContext = this.getTabPrivacyContext(tab);
		if(isPrivate === undefined)
			isPrivate = !privacyContext.usePrivateBrowsing;

		if(
			!isPrivate
			&& privacyContext.usePrivateBrowsing
			&& this.isLastPrivate(tab)
		) {
			_log("toggleTabPrivate() called for last private tab");
			if(this.forbidCloseLastPrivate())
				return undefined;
		}

		privacyContext.usePrivateBrowsing = isPrivate;

		// Workaround for browser.newtab.preload = true
		var browser = tab.linkedBrowser;
		browser._privateTabIsPrivate = isPrivate;
		tab.ownerDocument.defaultView.setTimeout(function() {
			delete browser._privateTabIsPrivate;
		}, 0);

		_log("Set usePrivateBrowsing to " + isPrivate + "\nTab: " + (tab.getAttribute("label") || "").substr(0, 255));
		if(!_silent)
			this.dispatchAPIEvent(tab, "PrivateTab:PrivateChanged", isPrivate);
		return isPrivate;
	},
	toggleWindowPrivate: function(window, isPrivate) {
		var gBrowser = window.gBrowser;
		if(isPrivate === undefined)
			this.isPrivateWindow(window.content);
		//~ todo: add pref for this?
		//this.getPrivacyContext(window).usePrivateBrowsing = true;
		_log("Make all tabs in window private");
		Array.forEach(gBrowser.tabs, function(tab) {
			this.toggleTabPrivate(tab, isPrivate);
		}, this);
	},
	getTabBrowser: function(tab) {
		return this.getTabBrowserFromChild(tab.linkedBrowser);
	},
	getTabForBrowser: function(browser) {
		var gBrowser = this.getTabBrowserFromChild(browser);
		var browsers = gBrowser.browsers;
		for(var i = 0, l = browsers.length; i < l; ++i)
			if(browsers[i] == browser)
				return gBrowser.tabs[i];
		return null;
	},
	getTabBrowserFromChild: function(node) {
		for(var tbr = node; tbr; tbr = tbr.parentNode)
			if(tbr.localName == "tabbrowser")
				return tbr;
		return node.ownerDocument.defaultView.gBrowser;
	},
	getTabBarFromChild: function(node) {
		for(; node && "classList" in node; node = node.parentNode)
			if(node.classList.contains("tabbrowser-tabs"))
				return node;
		return null;
	},
	getTabFromChild: function(node) {
		for(; node && "classList" in node; node = node.parentNode)
			if(node.classList.contains("tabbrowser-tab"))
				return node;
		return null;
	},
	get dwu() {
		delete this.dwu;
		return this.dwu = Components.classes["@mozilla.org/inspector/dom-utils;1"]
			.getService(Components.interfaces.inIDOMUtils);
	},
	getTopWindow: function(window) {
		for(;;) {
			var browser = this.dwu.getParentForNode(window.document, true);
			if(!browser)
				break;
			window = browser.ownerDocument.defaultView.top;
		}
		return window;
	},
	ensureTitleModifier: function(document) {
		var root = document.documentElement;
		if(
			root.hasAttribute("titlemodifier_normal")
			&& root.hasAttribute("titlemodifier_privatebrowsing")
		)
			return;
		var tm = root.getAttribute("titlemodifier") || "";
		var tmPrivate = root.getAttribute("titleprivate") || "";
		// SeaMonkey >= 2.19a1 (2013-03-27)
		// See chrome://navigator/content/navigator.js, function Startup()
		if(tmPrivate)
			tmPrivate = (tm ? tm + " " : "") + tmPrivate;
		else
			tmPrivate = tm + this.getLocalized("privateBrowsingTitleModifier");
		root.setAttribute("privateTab_titlemodifier_normal", tm);
		root.setAttribute("privateTab_titlemodifier_privatebrowsing", tmPrivate);
	},
	destroyTitleModifier: function(document) {
		var root = document.documentElement;
		if(!root.hasAttribute("privateTab_titlemodifier_normal"))
			return;
		root.removeAttribute("privateTab_titlemodifier_normal");
		root.removeAttribute("privateTab_titlemodifier_privatebrowsing");
	},
	appButtonCssURI: null,
	appButtonNA: false,
	appButtonDontChange: false,
	fixAppButtonWidth: function(document) {
		if(this.appButtonCssURI || this.appButtonNA || this.appButtonDontChange)
			return;
		var root = document.documentElement;
		if(root.getAttribute("privatebrowsingmode") != "temporary")
			return;
		var appBtn = document.getElementById("appmenu-button");
		if(!appBtn) {
			this.appButtonNA = true;
			return;
		}
		var bo = appBtn.boxObject;
		var pbWidth = bo.width;
		if(!pbWidth) { // App button are hidden?
			this.watchAppButton(document.defaultView);
			this.appButtonNA = true; // Don't check and don't call watchAppButton() again
			return;
		}
		root.removeAttribute("privatebrowsingmode");
		var npbWidth = bo.width;
		var iconWidth = pbWidth - npbWidth;
		root.setAttribute("privatebrowsingmode", "temporary");
		if(iconWidth == 0) {
			_log("Fix App button width: nothing to do, width are the same");
			this.appButtonNA = true;
			return;
		}
		var cssStr;
		if(iconWidth > 0) {
			var half = iconWidth/2;
			var s = document.defaultView.getComputedStyle(appBtn, null);
			var pl = parseFloat(s.paddingLeft) - half;
			var pr = parseFloat(s.paddingRight) - half;
			if(pl >= 0 && pr >= 0) {
				_log("Fix App button width:\npadding-left: " + pl + "px\npadding-right: " + pr + "px");
				cssStr = '\
					@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");\n\
					@-moz-document url("' + document.documentURI + '") {\n\
						#main-window[privatebrowsingmode="temporary"] #appmenu-button {\n\
							padding-left: ' + pl + 'px !important;\n\
							padding-right: ' + pr + 'px !important;\n\
						}\n\
					}';
			}
		}
		if(!cssStr) { // Better than nothing :)
			var maxWidth = Math.max(pbWidth, npbWidth);
			_log("Fix App button width:\nmin-width: " + maxWidth + "px");
			cssStr = '\
				@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");\n\
				@-moz-document url("' + document.documentURI + '") {\n\
					#appmenu-button {\n\
						min-width: ' + maxWidth + 'px !important;\n\
					}\n\
				}';
		}
		var cssURI = this.appButtonCssURI = Services.io.newURI(
			"data:text/css," + encodeURIComponent(cssStr), null, null
		);
		var sss = this.sss;
		if(!sss.sheetRegistered(cssURI, sss.USER_SHEET))
			sss.loadAndRegisterSheet(cssURI, sss.USER_SHEET);
	},
	restoreAppButtonWidth: function() {
		var cssURI = this.appButtonCssURI;
		if(!cssURI)
			return;
		this.appButtonCssURI = null;
		var sss = this.sss;
		if(sss.sheetRegistered(cssURI, sss.USER_SHEET))
			sss.unregisterSheet(cssURI, sss.USER_SHEET);
	},
	watchAppButton: function(window) {
		var titlebar = window.document.getElementById("titlebar");
		if(!titlebar)
			return;
		_log("Watch for #titlebar changes");
		var mo = window._privateTabAppButtonWatcher = new window.MutationObserver(function(mutations) {
			if(
				!mutations.some(function(mutation) {
					return mutation.attributeName == "hidden";
				})
				|| titlebar.hidden
			)
				return;
			_log("#titlebar is now visible!");
			mo.disconnect();
			delete window._privateTabAppButtonWatcher;
			this.appButtonNA = false;
			this.fixAppButtonWidth(window.document);
		}.bind(this));
		mo.observe(titlebar, { attributes: true });
	},
	unwatchAppButton: function(window) {
		if("_privateTabAppButtonWatcher" in window) {
			window._privateTabAppButtonWatcher.disconnect();
			delete window._privateTabAppButtonWatcher;
		}
	},
	updateWindowTitle: function(gBrowser, isPrivate) {
		var document = gBrowser.ownerDocument;
		if(isPrivate === undefined)
			isPrivate = this.isPrivateWindow(document.defaultView.content);
		var root = document.documentElement;
		var tm = isPrivate
			? root.getAttribute("titlemodifier_privatebrowsing")
				|| root.getAttribute("privateTab_titlemodifier_privatebrowsing")
			: root.getAttribute("titlemodifier_normal")
				|| root.getAttribute("privateTab_titlemodifier_normal");
		if(root.getAttribute("titlemodifier") == tm)
			return;
		_log("updateWindowTitle() " + tm);
		root.setAttribute("titlemodifier", tm);
		root.setAttribute(
			"title",
			isPrivate
				? root.getAttribute("title_privatebrowsing")
				: root.getAttribute("title_normal")
		);
		if(isPrivate) {
			var pbTemp = !PrivateBrowsingUtils.permanentPrivateBrowsing;
			root.setAttribute("privatebrowsingmode", pbTemp ? "temporary" : "permanent");
			pbTemp && this.fixAppButtonWidth(document);
		}
		else {
			root.removeAttribute("privatebrowsingmode");
		}
		// See chrome://browser/content/browser.js, gPrivateBrowsingUI.init()
		// http://hg.mozilla.org/mozilla-central/file/55f750590259/browser/base/content/browser.js#l6734
		if(Services.appinfo.OS == "Darwin") {
			if(isPrivate && pbTemp)
				root.setAttribute("drawintitlebar", "true");
			else
				root.removeAttribute("drawintitlebar");
		}
		gBrowser.updateTitlebar();
		this.privateChanged(document, isPrivate);
	},
	privateChanged: function(document, isPrivate) {
		this.updateAppButtonWidth(document);
		if(prefs.get("patchDownloads"))
			this.updateDownloadPanel(document.defaultView, isPrivate);
	},
	updateAppButtonWidth: function(document, force) {
		var window = document.defaultView;
		if(
			"TabsInTitlebar" in window
			&& "_sizePlaceholder" in window.TabsInTitlebar
			&& (force || !this.appButtonCssURI)
		) {
			window.setTimeout(function() { // Pseudo async
				// Based on code from chrome://browser/content/browser.js
				var appBtnBox = document.getElementById("appmenu-button-container");
				if(appBtnBox) {
					var rect = appBtnBox.getBoundingClientRect();
					if(rect.width) {
						_log("Update size placeholder for App button");
						window.TabsInTitlebar._sizePlaceholder("appmenu-button", rect.width);
					}
				}
			}, 0);
		}
	},
	updateDownloadPanel: function(window, isPrivate) {
		if(
			!( // SeaMonkey?
				"DownloadsView" in window
				&& "DownloadsPanel" in window
				&& "DownloadsIndicatorView" in window
				&& "DownloadsCommon" in window
			) || window.DownloadsCommon.useToolkitUI
		)
			return;
		var pt = window.privateTab;
		window.clearTimeout(pt._updateDownloadPanelTimer);
		pt._updateDownloadPanelTimer = window.setTimeout(function() {
			// See chrome://browser/content/downloads/downloads.js,
			// chrome://browser/content/downloads/indicator.js,
			// resource:///modules/DownloadsCommon.jsm
			// Clear download panel:
			if(window.DownloadsPanel._state != window.DownloadsPanel.kStateUninitialized) {
				window.DownloadsView.onDataInvalidated(); // This calls DownloadsPanel.terminate();
				_log("updateDownloadPanel() => DownloadsView.onDataInvalidated()");
				window.DownloadsPanel.initialize(function() {
					_log("updateDownloadPanel() => DownloadsPanel.initialize() done");
				});
				_log("updateDownloadPanel() => DownloadsPanel.initialize()");
			}
			// Reinitialize download indicator:
			var diw = window.DownloadsIndicatorView;
			if(diw._initialized) {
				//~ hack: cleanup raw download data, see DownloadsCommon.getData()
				var global = Components.utils.getGlobalForObject(window.DownloadsCommon);
				var data = isPrivate
					? global.DownloadsIndicatorData
					: global.PrivateDownloadsIndicatorData;
				var views = data._views;
				for(var i = views.length - 1; i >= 0; --i) {
					var view = views[i];
					if(Components.utils.getGlobalForObject(view) == window)
						data.removeView(view);
				}
				// Restart download indicator:
				diw.ensureTerminated();
				diw.ensureInitialized();
				_log("updateDownloadPanel() => reinitialize download indicator");
			}
		}, 100);
	},
	_overrideIsPrivate: undefined,
	patchPrivateBrowsingUtils: function(applyPatch) {
		var meth = "isWindowPrivate";
		var key = "PrivateBrowsingUtils.isWindowPrivate";
		if(applyPatch) {
			var _this = this;
			var pbu = PrivateBrowsingUtils;
			pbu._privateTabOrigIsWindowPrivate = pbu.isWindowPrivate;
			patcher.wrapFunction(pbu, meth, key,
				function before(window) {
					if(
						!window
						|| !(window instanceof Components.interfaces.nsIDOMChromeWindow)
						|| !_this.isTargetWindow(window)
					)
						return false;
					var isPrivate = _this._overrideIsPrivate;
					if(isPrivate !== undefined) {
						_log(key + "(): override to " + isPrivate);
						return { value: isPrivate };
					}
					if(!prefs.get("patchDownloads"))
						return false;
					var stack = new Error().stack;
					_dbgv && _log(key + "():\n" + stack);
					if(
						stack.indexOf("@chrome://browser/content/downloads/downloads.js:") != -1
						|| stack.indexOf("@resource://app/modules/DownloadsCommon.jsm:") != -1
						|| stack.indexOf("@resource://app/components/DownloadsUI.js:") != -1
						|| stack.indexOf("@resource://gre/modules/DownloadsCommon.jsm:") != -1
						|| stack.indexOf("@resource://gre/components/DownloadsUI.js:") != -1
					) try {
						var isPrivate = _this.isPrivateWindow(window.content);
						_dbgv && _log(key + "(): return state of selected tab: " + isPrivate);
						return { value: isPrivate };
					}
					catch(e) {
						Components.utils.reportError(e);
					}
					return false;
				}
			);
		}
		else {
			patcher.unwrapFunction(PrivateBrowsingUtils, meth, key);
			delete PrivateBrowsingUtils._privateTabOrigIsWindowPrivate;
		}
		_log("patchPrivateBrowsingUtils(" + applyPatch + ")");
	},

	getPrivacyContext: function(window) {
		return PrivateBrowsingUtils.privacyContextFromWindow(window);
	},
	isPrivateWindow: function(window) {
		return window && PrivateBrowsingUtils._privateTabOrigIsWindowPrivate(window);
	},
	getTabPrivacyContext: function(tab) {
		return this.getPrivacyContext(tab.linkedBrowser.contentWindow);
	},
	isPrivateTab: function(tab) {
		return tab && this.getTabPrivacyContext(tab).usePrivateBrowsing;
	},
	isPendingTab: function(tab) {
		return tab.hasAttribute("pending")
			|| tab.linkedBrowser.contentDocument.readyState == "uninitialized";
	},

	isLastPrivate: function(tabOrWindow) {
		var ourTab, ourWindow;
		if(tabOrWindow instanceof Components.interfaces.nsIDOMChromeWindow)
			ourWindow = tabOrWindow;
		else if(tabOrWindow.ownerDocument)
			ourTab = tabOrWindow;
		return !this.windows.some(function(window) {
			return window != ourWindow && this.hasPrivateTab(window, ourTab);
		}, this);
	},
	hasPrivateTab: function(window, ignoreTab) {
		return Array.some(
			window.gBrowser.tabs,
			function(tab) {
				return tab != ignoreTab && this.isPrivateTab(tab);
			},
			this
		);
	},
	forbidCloseLastPrivate: function() {
		var exitingCanceled = Components.classes["@mozilla.org/supports-PRBool;1"]
			.createInstance(Components.interfaces.nsISupportsPRBool);
		exitingCanceled.data = false;
		Services.obs.notifyObservers(exitingCanceled, "last-pb-context-exiting", null);
		return exitingCanceled.data;
	},

	privateAttr: "privateTab-isPrivate",
	get ss() {
		delete this.ss;
		return this.ss = (
			Components.classes["@mozilla.org/browser/sessionstore;1"]
			|| Components.classes["@mozilla.org/suite/sessionstore;1"]
		).getService(Components.interfaces.nsISessionStore);
	},

	_stylesLoaded: false,
	loadStyles: function(window) {
		if(this._stylesLoaded)
			return;
		this._stylesLoaded = true;
		var sss = this.sss;
		var cssURI = this.cssURI = this.makeCSSURI(window);
		if(!sss.sheetRegistered(cssURI, sss.USER_SHEET))
			sss.loadAndRegisterSheet(cssURI, sss.USER_SHEET);
	},
	unloadStyles: function() {
		if(!this._stylesLoaded)
			return;
		this._stylesLoaded = false;
		var sss = this.sss;
		if(sss.sheetRegistered(this.cssURI, sss.USER_SHEET))
			sss.unregisterSheet(this.cssURI, sss.USER_SHEET);
	},
	get sss() {
		delete this.sss;
		return this.sss = Components.classes["@mozilla.org/content/style-sheet-service;1"]
			.getService(Components.interfaces.nsIStyleSheetService);
	},
	makeCSSURI: function(window) {
		var document = window.document;
		var s = document.documentElement.style;
		var prefix = "textDecorationColor" in s && "textDecorationStyle" in s
			? ""
			: "-moz-";
		var ttColor = "-moz-nativehyperlinktext";
		var ttAddStyles = "";
		var tt = this.getTabTooltip(document)
			|| document.getElementsByTagName("tooltip")[0];
		var ttOrigColor = tt && window.getComputedStyle(tt, null).color;
		_log("Original tooltip color: " + ttOrigColor);
		if(/^rgb\((\d+), *(\d+), *(\d+)\)$/.test(ttOrigColor)) {
			var r = +RegExp.$1, g = +RegExp.$2, b = +RegExp.$3;
			var brightness = Math.max(r/255, g/255, b/255); // HSV, 0..1
			if(brightness > 0.5) { // Bright text, dark background
				ttColor = "currentColor";
				ttAddStyles = '\n\
					font-weight: bold;\n\
					text-decoration: underline;\n\
					' + prefix + 'text-decoration-color: currentColor;\n\
					' + prefix + 'text-decoration-style: dashed;';
			}
		}
		var cssStr = '\
			@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");\n\
			@-moz-document url("' + document.documentURI + '") {\n\
				.tabbrowser-tab[' + this.privateAttr + '] {\n\
					text-decoration: underline !important;\n\
					' + prefix + 'text-decoration-color: -moz-nativehyperlinktext !important;\n\
					' + prefix + 'text-decoration-style: dashed !important;\n\
				}\n\
				.tabbrowser-tab[' + this.privateAttr + '][pinned] .tab-icon-image,\n\
				.tabbrowser-tab[' + this.privateAttr + '][pinned] .tab-throbber {\n\
					border-bottom: 1px dashed -moz-nativehyperlinktext !important;\n\
				}\n\
				#' + this.tabTipId + ' {\n\
					color: ' + ttColor + ';' + ttAddStyles + '\n\
				}\n\
				#' + this.tabScopeTipId + '{\n\
					color: -moz-nativehyperlinktext;\n\
					text-align: center;\n\
					margin: 1px;\n\
				}\n\
			}\n\
			@-moz-document url("' + document.documentURI + '"),\n\
				url("chrome://global/content/customizeToolbar.xul") {\n\
				#' + this.toolbarButtonId + ' {\n\
					list-style-image: url("chrome://privatetab/content/privacy-24.png") !important;\n\
					-moz-image-region: auto !important;\n\
				}\n\
				toolbar[iconsize="small"] #' + this.toolbarButtonId + ' {\n\
					list-style-image: url("chrome://privatetab/content/privacy-16.png") !important;\n\
				}\n\
			}';
		return Services.io.newURI("data:text/css," + encodeURIComponent(cssStr), null, null);
	},

	get bundle() {
		try {
			var bundle = Services.strings.createBundle("chrome://privatetab/locale/pt.properties");
		}
		catch(e) {
			Components.utils.reportError(e);
		}
		delete this.bundle;
		return this.bundle = bundle;
	},
	getLocalized: function(sid) {
		try {
			return this.bundle.GetStringFromName(sid);
		}
		catch(e) {
			Components.utils.reportError(LOG_PREFIX + "Can't get localized string for \"" + sid + "\"");
			Components.utils.reportError(e);
		}
		return sid;
	}
};

var privateTabInternal = windowsObserver;
function API(window) {
	this.window = window;
}
API.prototype = {
	_openNewTabsPrivate: undefined,
	_ssWindowBusy: false,
	_ssWindowBusyRestoreTimer: 0,
	_updateDownloadPanelTimer: 0,
	_checkLastPrivate: true,
	_destroy: function() {
		if(this._openNewTabsPrivate !== undefined)
			this.stopToOpenTabs();
		this.window = null;
	},
	handleEvent: function(e) {
		if(e.type == "TabOpen" && this._openNewTabsPrivate !== undefined)
			privateTabInternal.toggleTabPrivate(e.originalTarget || e.target, this._openNewTabsPrivate);
	},
	_onFirstPrivateTab: function(window, tab) {
		this._onFirstPrivateTab = function() {};
		_log("First private tab in window");
		if(!privateTabInternal.isPrivateWindow(window)) {
			window.setTimeout(function() {
				privateTabInternal.ensureTabBrowserLoadURIPatched(window);
			}, 50);
		}
	},
	// Public API:
	isTabPrivate: function privateTab_isTabPrivate(tab) {
		return privateTabInternal.isPrivateTab(tab);
	},
	toggleTabPrivate: function privateTab_toggleTabPrivate(tab, isPrivate) {
		isPrivate = privateTabInternal.toggleTabPrivate(tab, isPrivate);
		privateTabInternal.fixTabState(tab, isPrivate);
		return isPrivate;
	},
	readyToOpenTab: function privateTab_readyToOpenTab(isPrivate) {
		privateTabInternal.waitForTab(this.window, function(tab) {
			if(!tab)
				return;
			tab._privateTabIgnore = true;
			privateTabInternal.toggleTabPrivate(tab, isPrivate);
		}.bind(this));
	},
	readyToOpenTabs: function privateTab_readyToOpenTabs(isPrivate) {
		this._openNewTabsPrivate = isPrivate;
		this.window.addEventListener("TabOpen", this, true);
	},
	stopToOpenTabs: function  privateTab_stopToOpenTabs() {
		this._openNewTabsPrivate = undefined;
		this.window.removeEventListener("TabOpen", this, true);
	}
};

var prefs = {
	ns: "extensions.privateTab.",
	initialized: false,
	init: function() {
		if(this.initialized)
			return;
		this.initialized = true;

		//~ todo: add condition when https://bugzilla.mozilla.org/show_bug.cgi?id=564675 will be fixed
		this.loadDefaultPrefs();
		if(windowsObserver.isSeaMonkey) {
			var defaultBranch = Services.prefs.getDefaultBranch("");
			this.setPref(this.ns + "dragAndDropTabsBetweenDifferentWindows", false, defaultBranch);
			this.setPref(this.ns + "patchDownloads", false, defaultBranch);
		}
		Services.prefs.addObserver(this.ns, this, false);
	},
	destroy: function() {
		if(!this.initialized)
			return;
		this.initialized = false;

		Services.prefs.removeObserver(this.ns, this);
	},
	observe: function(subject, topic, pName) {
		if(topic != "nsPref:changed")
			return;
		var shortName = pName.substr(this.ns.length);
		var val = this.getPref(pName);
		this._cache[shortName] = val;
		windowsObserver.prefChanged(shortName, val);
	},

	loadDefaultPrefs: function() {
		var defaultBranch = Services.prefs.getDefaultBranch("");
		var prefsFile = "chrome://privatetab/content/defaults/preferences/prefs.js";
		var prefs = this;
		Services.scriptloader.loadSubScript(prefsFile, {
			pref: function(pName, val) {
				var pType = defaultBranch.getPrefType(pName);
				if(pType != defaultBranch.PREF_INVALID && pType != prefs.getValueType(val)) {
					Components.utils.reportError(
						LOG_PREFIX + 'Changed preference type for "' + pName
						+ '", old value will be lost!'
					);
					defaultBranch.deleteBranch(pName);
				}
				prefs.setPref(pName, val, defaultBranch);
			}
		});
	},

	_cache: { __proto__: null },
	get: function(pName, defaultVal) {
		var cache = this._cache;
		return pName in cache
			? cache[pName]
			: (cache[pName] = this.getPref(this.ns + pName, defaultVal));
	},
	set: function(pName, val) {
		return this.setPref(this.ns + pName, val);
	},
	getPref: function(pName, defaultVal, prefBranch) {
		var ps = prefBranch || Services.prefs;
		switch(ps.getPrefType(pName)) {
			case ps.PREF_BOOL:   return ps.getBoolPref(pName);
			case ps.PREF_INT:    return ps.getIntPref(pName);
			case ps.PREF_STRING: return ps.getComplexValue(pName, Components.interfaces.nsISupportsString).data;
		}
		return defaultVal;
	},
	setPref: function(pName, val, prefBranch) {
		var ps = prefBranch || Services.prefs;
		var pType = ps.getPrefType(pName);
		if(pType == ps.PREF_INVALID)
			pType = this.getValueType(val);
		switch(pType) {
			case ps.PREF_BOOL:   ps.setBoolPref(pName, val); break;
			case ps.PREF_INT:    ps.setIntPref(pName, val);  break;
			case ps.PREF_STRING:
				var ss = Components.interfaces.nsISupportsString;
				var str = Components.classes["@mozilla.org/supports-string;1"]
					.createInstance(ss);
				str.data = val;
				ps.setComplexValue(pName, ss, str);
		}
		return this;
	},
	getValueType: function(val) {
		switch(typeof val) {
			case "boolean": return Services.prefs.PREF_BOOL;
			case "number":  return Services.prefs.PREF_INT;
		}
		return Services.prefs.PREF_STRING;
	}
};

// Be careful, loggers always works until prefs aren't initialized
// (and if "debug" preference has default value)
var _dbg = true, _dbgv = true;
function ts() {
	var d = new Date();
	var ms = d.getMilliseconds();
	return d.toLocaleFormat("%M:%S:") + "000".substr(String(ms).length) + ms + " ";
}
function _log(s) {
	if(!_dbg)
		return;
	var msg = LOG_PREFIX + ts() + s;
	Services.console.logStringMessage(msg);
	dump(msg + "\n");
}