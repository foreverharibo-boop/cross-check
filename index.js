import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = "crosscheck";
const PCC_MODULE_NAME = "persistent-custom-css";
const PCC_STYLE_ID = "persistent-custom-css-style";
const MAX_RESULTS = 140;
const MAX_ERRORS = 30;

const defaultSettings = {
    includeDisabledPersistentCss: true,
};

let latestReport = null;
let picking = false;
let highlightedElement = null;
let styleMutationObserver = null;
const recentErrors = [];
const recentStyleChanges = [];

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!(key in settings)) settings[key] = value;
    }
    return settings;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortText(value, length = 180) {
    const text = normalizeWhitespace(value);
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function setStatus(message) {
    $("#crosscheck-status").text(message || "");
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function splitSelectors(selectorText) {
    const selectors = [];
    let current = "";
    let depth = 0;
    let quote = "";
    let escaped = false;

    for (const char of String(selectorText ?? "")) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            current += char;
            escaped = true;
            continue;
        }
        if (quote) {
            current += char;
            if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            current += char;
            quote = char;
            continue;
        }
        if (char === "(" || char === "[") depth += 1;
        if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
        if (char === "," && depth === 0) {
            if (current.trim()) selectors.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim()) selectors.push(current.trim());
    return selectors;
}

function specificity(selector) {
    let text = String(selector ?? "")
        .replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "")
        .replace(/\\./g, "x")
        .replace(/\[[^\]]*\]/g, "[]");

    const ids = (text.match(/#[\w-]+/g) || []).length;
    const attrs = (text.match(/\[\]/g) || []).length;
    const classes = (text.match(/\.[\w-]+/g) || []).length;
    const pseudoClasses = (text.match(/:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
    text = text
        .replace(/#[\w-]+/g, " ")
        .replace(/\.[\w-]+/g, " ")
        .replace(/\[\]/g, " ")
        .replace(/::?[\w-]+(?:\([^)]*\))?/g, " ")
        .replace(/[>+~*]/g, " ");
    const elements = (text.match(/(^|\s|\|)[a-zA-Z][\w-]*/g) || []).length;
    const pseudoElements = (String(selector).match(/::[\w-]+/g) || []).length;
    return [ids, attrs + classes + pseudoClasses, elements + pseudoElements];
}

function compareSpecificity(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

function propertyFamily(property) {
    const prop = String(property ?? "").toLowerCase();
    if (prop.startsWith("--")) return prop;
    if (/^(margin|padding)(-|$)/.test(prop)) return prop.split("-")[0];
    if (/^inset(-|$)/.test(prop) || /^(top|right|bottom|left)$/.test(prop)) return "inset";
    if (/^border($|-top|-right|-bottom|-left)(-|$)/.test(prop)) {
        const side = prop.match(/^border-(top|right|bottom|left)/)?.[1];
        return side ? `border-${side}` : "border";
    }
    if (/^border-radius$|^border-(top|bottom)-(left|right)-radius$/.test(prop)) return "border-radius";
    if (/^background($|-)/.test(prop)) return "background";
    if (/^font($|-)/.test(prop)) return "font";
    if (/^animation($|-)/.test(prop)) return "animation";
    if (/^transition($|-)/.test(prop)) return "transition";
    if (/^overflow($|-)/.test(prop)) return "overflow";
    if (/^flex($|-)/.test(prop)) return "flex";
    if (/^grid($|-)/.test(prop)) return "grid";
    return prop;
}

function isInterestingSource(source) {
    return ["persistent", "extension", "theme", "custom"].includes(source?.kind);
}

function sourceFromStyleSheet(sheet, index) {
    const owner = sheet.ownerNode;
    const href = sheet.href || owner?.href || "";
    const ownerId = owner?.id || "";

    if (ownerId === PCC_STYLE_ID) {
        return { key: "persistent-combined", label: "등록 CSS(결합본)", kind: "persistent", skip: true };
    }

    if (href) {
        let pathname = href;
        try {
            pathname = new URL(href, location.href).pathname;
        } catch {
            // 원본 문자열을 그대로 사용
        }
        const extensionMatch = pathname.match(/\/scripts\/extensions\/((?:third-party\/)?[^/]+)\/(.+)$/i);
        if (extensionMatch) {
            const extensionPath = decodeURIComponent(extensionMatch[1]);
            const file = decodeURIComponent(extensionMatch[2]);
            return {
                key: `extension:${extensionPath}:${file}`,
                label: `확장 CSS · ${extensionPath} / ${file}`,
                kind: "extension",
                extensionPath,
                href,
            };
        }
        if (/theme|themes/i.test(pathname)) {
            return { key: `theme:${pathname}`, label: `테마 CSS · ${pathname.split("/").pop()}`, kind: "theme", href };
        }
        return { key: `core:${pathname}`, label: `SillyTavern · ${pathname.split("/").pop()}`, kind: "core", href };
    }

    if (/custom|user|theme/i.test(ownerId) || /custom|user|theme/i.test(owner?.dataset?.name || "")) {
        return {
            key: `custom:${ownerId || index}`,
            label: `사용자/테마 CSS · ${ownerId || `inline-${index + 1}`}`,
            kind: "custom",
        };
    }

    const hint = ownerId ? `#${ownerId}` : owner?.dataset?.extension || `inline-${index + 1}`;
    return { key: `inline:${hint}`, label: `인라인 CSS · ${hint}`, kind: "inline" };
}

function isCrosscheckSource(source) {
    return /(?:^|\/)(?:crosscheck|CrossCheck-main)(?:\/|:|$)/i.test(source?.key || "")
        || /크로스체크/.test(source?.label || "");
}

function mediaIsActive(mediaText) {
    if (!mediaText || mediaText === "all") return true;
    try {
        return window.matchMedia(mediaText).matches;
    } catch {
        return true;
    }
}

function walkCssRules(ruleList, source, state, output, diagnostics) {
    for (const rule of Array.from(ruleList || [])) {
        state.order += 1;

        if (rule.type === CSSRule.STYLE_RULE) {
            const selectors = splitSelectors(rule.selectorText);
            for (const selector of selectors) {
                if (!selector || selector.startsWith("#crosscheck")) continue;
                for (const property of Array.from(rule.style || [])) {
                    output.push({
                        selector,
                        normalizedSelector: normalizeWhitespace(selector),
                        property,
                        family: propertyFamily(property),
                        value: rule.style.getPropertyValue(property).trim(),
                        important: rule.style.getPropertyPriority(property) === "important",
                        active: state.active,
                        disabledSource: state.disabledSource,
                        media: state.media,
                        source,
                        order: state.order,
                        specificity: specificity(selector),
                    });
                }
            }
            continue;
        }

        if (rule.type === CSSRule.MEDIA_RULE) {
            const condition = rule.conditionText || rule.media?.mediaText || "";
            const nestedState = {
                ...state,
                active: state.active && mediaIsActive(condition),
                media: condition,
            };
            walkCssRules(rule.cssRules, source, nestedState, output, diagnostics);
            state.order = Math.max(state.order, nestedState.order);
            continue;
        }

        if (rule.type === CSSRule.SUPPORTS_RULE) {
            let supported = true;
            try {
                supported = CSS.supports(rule.conditionText);
            } catch {
                supported = true;
            }
            const nestedState = { ...state, active: state.active && supported };
            walkCssRules(rule.cssRules, source, nestedState, output, diagnostics);
            state.order = Math.max(state.order, nestedState.order);
            continue;
        }

        if (rule.type === CSSRule.KEYFRAMES_RULE) {
            diagnostics.keyframes.push({
                name: rule.name,
                source,
                active: state.active,
            });
            continue;
        }

        if (rule.cssRules) {
            const nestedState = { ...state };
            walkCssRules(rule.cssRules, source, nestedState, output, diagnostics);
            state.order = Math.max(state.order, nestedState.order);
        }
    }
}

function parseCssText(cssText, source, active, orderStart, diagnostics) {
    const output = [];
    const state = { order: orderStart, active, disabledSource: !active, media: "" };

    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        walkCssRules(sheet.cssRules, source, state, output, diagnostics);
        return { rules: output, order: state.order };
    } catch (firstError) {
        const style = document.createElement("style");
        style.media = "not all";
        style.dataset.crosscheckParser = "true";
        style.textContent = cssText;
        document.head.appendChild(style);
        try {
            walkCssRules(style.sheet?.cssRules, source, state, output, diagnostics);
            return { rules: output, order: state.order };
        } catch (secondError) {
            diagnostics.parseErrors.push({ source, message: secondError?.message || firstError?.message || "CSS를 해석할 수 없음" });
            return { rules: output, order: state.order };
        } finally {
            style.remove();
        }
    }
}

function collectPersistentCssRules(orderStart, includeDisabled, diagnostics) {
    const pcc = extension_settings[PCC_MODULE_NAME];
    if (!pcc || !Array.isArray(pcc.entries)) {
        return { rules: [], order: orderStart, entryCount: 0, activeEntryCount: 0 };
    }

    const folderMap = new Map((Array.isArray(pcc.folders) ? pcc.folders : []).map(folder => [folder.id, folder.title || "이름 없는 폴더"]));
    const output = [];
    let order = orderStart;
    let activeEntryCount = 0;

    for (const [index, entry] of pcc.entries.entries()) {
        if (!entry?.css?.trim()) continue;
        if (!entry.enabled && !includeDisabled) continue;
        if (entry.enabled) activeEntryCount += 1;

        const folder = entry.folderId ? folderMap.get(entry.folderId) : "";
        const title = entry.title || `CSS ${index + 1}`;
        const path = folder ? `${folder} › ${title}` : title;
        const source = {
            key: `persistent:${entry.id || index}`,
            label: `등록 CSS · ${path}`,
            kind: "persistent",
            entryId: entry.id,
            entryTitle: title,
            folderTitle: folder,
            enabled: !!entry.enabled,
        };
        const parsed = parseCssText(entry.css, source, !!entry.enabled, order + 100, diagnostics);
        output.push(...parsed.rules);
        order = parsed.order + 100;
    }

    return {
        rules: output,
        order,
        entryCount: pcc.entries.filter(entry => entry?.css?.trim()).length,
        activeEntryCount,
    };
}

async function collectAllCssRules() {
    const settings = getSettings();
    const output = [];
    const diagnostics = { inaccessibleSheets: [], parseErrors: [], keyframes: [] };
    let order = 0;
    let readableSheets = 0;
    const styleSheets = Array.from(document.styleSheets);

    for (const [index, sheet] of styleSheets.entries()) {
        const source = sourceFromStyleSheet(sheet, index);
        if (source.skip || isCrosscheckSource(source)) continue;

        const sheetMedia = sheet.media?.mediaText || "";
        const active = !sheet.disabled && mediaIsActive(sheetMedia);
        try {
            const state = { order, active, disabledSource: !active, media: sheetMedia };
            walkCssRules(sheet.cssRules, source, state, output, diagnostics);
            order = state.order + 100;
            readableSheets += 1;
        } catch (error) {
            diagnostics.inaccessibleSheets.push({
                source,
                message: error?.message || "브라우저가 스타일 규칙 접근을 차단함",
            });
        }

        if (index > 0 && index % 12 === 0) await nextFrame();
    }

    const persistent = collectPersistentCssRules(order + 10000, settings.includeDisabledPersistentCss, diagnostics);
    output.push(...persistent.rules);

    return {
        rules: output,
        diagnostics,
        sheetCount: styleSheets.length,
        readableSheets,
        persistent,
    };
}

function distinctSources(records) {
    return new Set(records.map(record => record.source.key));
}

function distinctDeclarations(records) {
    return new Set(records.map(record => `${record.property}:${normalizeWhitespace(record.value)}:${record.important}`));
}

function displayDeclaration(record) {
    return `${record.property}: ${shortText(record.value, 130)}${record.important ? " !important" : ""}`;
}

function conflictResultsFromRules(rules) {
    const groups = new Map();

    for (const rule of rules) {
        const key = `${rule.normalizedSelector}\u0000${rule.family}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(rule);
    }

    const results = [];
    for (const records of groups.values()) {
        if (records.length < 2 || distinctSources(records).size < 2 || distinctDeclarations(records).size < 2) continue;
        if (!records.some(record => isInterestingSource(record.source))) continue;

        const activeRecords = records.filter(record => record.active);
        const activeSources = distinctSources(activeRecords);
        const activeDeclarations = distinctDeclarations(activeRecords);
        const confirmedCandidate = activeRecords.length > 1 && activeSources.size > 1 && activeDeclarations.size > 1;
        const hasInactive = records.some(record => !record.active);
        const selector = records[0].selector;
        const family = records[0].family;
        const sorted = [...records].sort((a, b) => a.order - b.order);
        const lines = sorted.slice(-6).map(record => ({
            source: record.source.label,
            text: `${displayDeclaration(record)}${record.active ? "" : " · 현재 비활성"}${record.media ? ` · @media ${record.media}` : ""}`,
        }));

        results.push({
            level: confirmedCandidate ? "high" : "medium",
            title: confirmedCandidate ? "활성 CSS 충돌 후보" : "비활성 CSS 잠재 충돌",
            meta: `${selector}  ·  ${family}`,
            lines,
            inactive: !confirmedCandidate && hasInactive,
        });
    }

    return results
        .sort((a, b) => (a.level === b.level ? 0 : a.level === "high" ? -1 : 1))
        .slice(0, MAX_RESULTS);
}

function duplicateIdResults() {
    const byId = new Map();
    for (const element of document.querySelectorAll("[id]")) {
        if (!element.id || element.closest("#crosscheck-overlay")) continue;
        if (!byId.has(element.id)) byId.set(element.id, []);
        byId.get(element.id).push(element);
    }

    return Array.from(byId.entries())
        .filter(([, elements]) => elements.length > 1)
        .slice(0, 30)
        .map(([id, elements]) => ({
            level: "medium",
            title: "중복 DOM ID",
            meta: `#${id}가 화면에 ${elements.length}개 존재합니다. 같은 요소를 찾는 확장끼리 엉뚱한 대상을 수정할 수 있습니다.`,
            lines: elements.slice(0, 4).map(element => ({ source: "화면 요소", text: elementDescriptor(element) })),
        }));
}

function keyframeResults(keyframes) {
    const groups = new Map();
    for (const item of keyframes) {
        if (!item.active) continue;
        if (!groups.has(item.name)) groups.set(item.name, []);
        groups.get(item.name).push(item);
    }
    return Array.from(groups.entries())
        .filter(([, items]) => distinctSources(items).size > 1)
        .map(([name, items]) => ({
            level: "medium",
            title: "애니메이션 이름 중복",
            meta: `@keyframes ${name}`,
            lines: items.map(item => ({ source: item.source.label, text: "같은 애니메이션 이름을 등록함" })),
        }));
}

function extensionPathFromUrl(url) {
    try {
        const pathname = new URL(url, location.href).pathname;
        return decodeURIComponent(pathname.match(/\/scripts\/extensions\/((?:third-party\/)?[^/]+)\//i)?.[1] || "");
    } catch {
        return "";
    }
}

function discoverLoadedExtensionPaths() {
    const urls = new Set();
    document.querySelectorAll("script[src], link[href]").forEach(node => urls.add(node.src || node.href));
    for (const item of performance.getEntriesByType("resource")) urls.add(item.name);
    for (const sheet of Array.from(document.styleSheets)) if (sheet.href) urls.add(sheet.href);

    return Array.from(urls)
        .map(extensionPathFromUrl)
        .filter(Boolean)
        .filter(path => !/crosscheck|CrossCheck-main/i.test(path))
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a.localeCompare(b));
}

async function loadExtensionManifests(paths) {
    const settled = await Promise.all(paths.map(async path => {
        try {
            const response = await fetch(`/scripts/extensions/${path}/manifest.json`, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const manifest = await response.json();
            let jsText = "";
            let jsError = "";
            if (manifest.js) {
                try {
                    const jsUrl = new URL(String(manifest.js), `${location.origin}/scripts/extensions/${path}/`);
                    const jsResponse = await fetch(jsUrl, { cache: "no-store" });
                    if (!jsResponse.ok) throw new Error(`HTTP ${jsResponse.status}`);
                    jsText = await jsResponse.text();
                } catch (error) {
                    jsError = error?.message || "진입 JS를 읽을 수 없음";
                }
            }
            return { ok: true, path, manifest, jsText, jsError };
        } catch (error) {
            return { ok: false, path, message: error?.message || "manifest를 읽을 수 없음" };
        }
    }));

    const manifests = settled.filter(item => item.ok);
    const failures = settled.filter(item => !item.ok);
    return { manifests, failures };
}

function regexMatches(text, regex, captureIndex = 1) {
    const found = new Set();
    for (const match of String(text || "").matchAll(regex)) {
        if (match[captureIndex]) found.add(match[captureIndex]);
    }
    return Array.from(found);
}

function extensionCodeResults(manifests) {
    const globalNames = new Map();
    const settingKeys = new Map();
    const createdIds = new Map();
    const riskyPatches = [];

    function add(map, key, item) {
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }

    for (const item of manifests) {
        const code = item.jsText || "";
        if (!code) continue;
        const displayName = item.manifest.display_name || item.path;

        for (const name of regexMatches(code, /(?:globalThis|window)\.([A-Za-z_$][\w$]*)\s*=/g)) {
            add(globalNames, name, { ...item, displayName });
        }
        for (const key of regexMatches(code, /extension_settings\s*\[\s*["']([^"']+)["']\s*\]/g)) {
            add(settingKeys, key, { ...item, displayName });
        }
        for (const key of regexMatches(code, /extension_settings\.([A-Za-z_$][\w$]*)/g)) {
            add(settingKeys, key, { ...item, displayName });
        }
        for (const id of regexMatches(code, /\bid\s*=\s*["']([A-Za-z][\w:.-]*)["']/g)) {
            add(createdIds, id, { ...item, displayName });
        }
        for (const id of regexMatches(code, /\.id\s*=\s*["']([A-Za-z][\w:.-]*)["']/g)) {
            add(createdIds, id, { ...item, displayName });
        }

        const patchPatterns = [
            [/(?:window|globalThis)\.fetch\s*=/, "전역 fetch 교체"],
            [/EventTarget\.prototype\.addEventListener\s*=/, "addEventListener 프로토타입 교체"],
            [/(?:jQuery|\$)\.fn\.[A-Za-z_$][\w$]*\s*=/, "jQuery 전역 기능 추가/교체"],
            [/MutationObserver\.prototype\.[A-Za-z_$][\w$]*\s*=/, "MutationObserver 프로토타입 교체"],
        ];
        for (const [pattern, label] of patchPatterns) {
            if (pattern.test(code)) riskyPatches.push({ item, displayName, label });
        }
    }

    const results = [];
    for (const [name, items] of globalNames.entries()) {
        const unique = new Map(items.map(item => [item.path, item]));
        if (unique.size < 2) continue;
        results.push({
            level: "high",
            title: "전역 JavaScript 이름 중복",
            meta: `window/globalThis.${name}을 여러 확장이 할당합니다. 나중에 로드된 확장이 앞의 값을 덮어쓸 수 있습니다.`,
            lines: Array.from(unique.values()).map(item => ({ source: item.displayName, text: item.path })),
        });
    }
    for (const [key, items] of settingKeys.entries()) {
        const unique = new Map(items.map(item => [item.path, item]));
        if (unique.size < 2) continue;
        results.push({
            level: "high",
            title: "확장 설정 저장 키 중복",
            meta: `extension_settings[${JSON.stringify(key)}]를 여러 확장이 사용합니다.`,
            lines: Array.from(unique.values()).map(item => ({ source: item.displayName, text: item.path })),
        });
    }
    for (const [id, items] of createdIds.entries()) {
        const unique = new Map(items.map(item => [item.path, item]));
        if (unique.size < 2) continue;
        results.push({
            level: "medium",
            title: "생성 DOM ID 중복 가능성",
            meta: `#${id}를 여러 확장 코드에서 생성합니다.`,
            lines: Array.from(unique.values()).map(item => ({ source: item.displayName, text: item.path })),
        });
    }
    for (const patch of riskyPatches) {
        results.push({
            level: "medium",
            title: "전역 동작 변경 감지",
            meta: `${patch.displayName}: ${patch.label}`,
            lines: [{ source: patch.item.path, text: "다른 확장의 실행에도 영향을 줄 수 있으므로 오류 발생 시 우선 확인하세요." }],
        });
    }
    return results.slice(0, 80);
}

function manifestResults(manifests, loadedPaths) {
    const results = [];
    const pathSet = new Set(loadedPaths);
    const interceptorGroups = new Map();
    const displayNameGroups = new Map();

    for (const item of manifests) {
        const manifest = item.manifest || {};
        if (manifest.generate_interceptor) {
            const name = manifest.generate_interceptor;
            if (!interceptorGroups.has(name)) interceptorGroups.set(name, []);
            interceptorGroups.get(name).push(item);
        }
        const displayName = manifest.display_name || item.path;
        if (!displayNameGroups.has(displayName)) displayNameGroups.set(displayName, []);
        displayNameGroups.get(displayName).push(item);

        for (const dependency of Array.isArray(manifest.dependencies) ? manifest.dependencies : []) {
            if (!pathSet.has(dependency)) {
                results.push({
                    level: "high",
                    title: "활성 의존 확장 확인 필요",
                    meta: `${displayName}에서 ${dependency}를 요구하지만 현재 로드 목록에서 찾지 못했습니다.`,
                    lines: [{ source: item.path, text: `dependencies: ${dependency}` }],
                });
            }
        }
    }

    for (const [name, items] of interceptorGroups.entries()) {
        if (items.length < 2) continue;
        results.push({
            level: "high",
            title: "생성 인터셉터 전역 이름 중복",
            meta: `${name}을 ${items.length}개 확장이 함께 등록했습니다.`,
            lines: items.map(item => ({
                source: item.manifest.display_name || item.path,
                text: `loading_order: ${item.manifest.loading_order ?? "미지정"}`,
            })),
        });
    }

    for (const [name, items] of displayNameGroups.entries()) {
        if (items.length < 2) continue;
        results.push({
            level: "medium",
            title: "확장 표시명 중복",
            meta: `${name}이라는 이름을 여러 확장이 사용합니다.`,
            lines: items.map(item => ({ source: item.path, text: "동일한 display_name" })),
        });
    }
    return results;
}

function errorResults() {
    return recentErrors.slice(-10).reverse().map(item => ({
        level: "high",
        title: item.type === "promise" ? "처리되지 않은 Promise 오류" : "최근 브라우저 오류",
        meta: item.message,
        lines: item.source ? [{ source: item.source, text: item.stack || item.message }] : [],
    }));
}

function winnerFromRecords(records) {
    return [...records].sort((a, b) => {
        if (a.important !== b.important) return a.important ? 1 : -1;
        if (a.inline !== b.inline) return a.inline ? 1 : -1;
        const specificityDifference = compareSpecificity(a.specificity, b.specificity);
        if (specificityDifference !== 0) return specificityDifference;
        return a.order - b.order;
    }).at(-1);
}

function selectorCanMatchElement(selector) {
    return !/::(?:before|after|first-letter|first-line|selection|backdrop|marker|placeholder|file-selector-button)/i.test(selector);
}

function safeMatches(element, selector) {
    if (!selectorCanMatchElement(selector)) return false;
    try {
        return element.matches(selector);
    } catch {
        return false;
    }
}

function elementDescriptor(element) {
    if (!(element instanceof Element)) return "알 수 없는 요소";
    let descriptor = element.tagName.toLowerCase();
    if (element.id) descriptor += `#${element.id}`;
    const classes = Array.from(element.classList).filter(name => name !== "crosscheck-pick-target").slice(0, 4);
    if (classes.length) descriptor += `.${classes.join(".")}`;
    return descriptor;
}

function elementConflictResults(element, rules) {
    const matching = rules.filter(rule => rule.active && safeMatches(element, rule.selector));
    let order = Math.max(0, ...matching.map(rule => rule.order)) + 10000;

    for (const property of Array.from(element.style || [])) {
        matching.push({
            selector: "style 속성",
            normalizedSelector: "style 속성",
            property,
            family: propertyFamily(property),
            value: element.style.getPropertyValue(property).trim(),
            important: element.style.getPropertyPriority(property) === "important",
            active: true,
            source: { key: "inline-attribute", label: "요소의 style 속성", kind: "custom" },
            order: order++,
            specificity: [1000, 0, 0],
            inline: true,
        });
    }

    const groups = new Map();
    for (const rule of matching) {
        if (!groups.has(rule.family)) groups.set(rule.family, []);
        groups.get(rule.family).push(rule);
    }

    const computed = getComputedStyle(element);
    const results = [];
    for (const [family, records] of groups.entries()) {
        if (records.length < 2 || distinctSources(records).size < 2 || distinctDeclarations(records).size < 2) continue;
        if (!records.some(record => isInterestingSource(record.source))) continue;

        const winner = winnerFromRecords(records);
        const computedValue = computed.getPropertyValue(winner.property).trim();
        const sorted = [...records].sort((a, b) => a.order - b.order);
        const lines = sorted.slice(-8).map(record => ({
            source: record.source.label,
            text: `${record.selector} → ${displayDeclaration(record)}${record === winner ? " · 우선 적용 예상" : ""}`,
        }));
        results.push({
            level: "high",
            title: "선택 요소에 실제로 겹치는 규칙",
            meta: `${family} · 현재 계산값: ${shortText(computedValue || "확인 불가", 120)}`,
            lines,
        });
    }

    return results.slice(0, MAX_RESULTS);
}

function sourceCount(rules) {
    return new Set(rules.map(rule => rule.source.key)).size;
}

function buildReportText(report) {
    const lines = [
        `🔀 크로스체크 진단 결과`,
        `검사 시각: ${new Date(report.createdAt).toLocaleString()}`,
        `검사 유형: ${report.mode === "element" ? `요소 선택 (${report.target})` : "전체 검사"}`,
        `로드 확장: ${report.summary.extensions} / CSS 출처: ${report.summary.sources} / 충돌·주의: ${report.summary.issues}`,
        "",
    ];

    for (const section of report.sections) {
        lines.push(`[${section.title}]`);
        if (!section.items.length) {
            lines.push("- 발견된 항목 없음", "");
            continue;
        }
        for (const item of section.items) {
            lines.push(`- ${item.title}: ${item.meta || ""}`.trim());
            for (const line of item.lines || []) lines.push(`  · ${line.source}: ${line.text}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

function reportItemHtml(item) {
    const lines = (item.lines || []).map(line => `
        <div class="cc-rule-line"><span class="cc-source">${escapeHtml(line.source)}</span> — ${escapeHtml(line.text)}</div>
    `).join("");
    return `
        <div class="cc-result" data-level="${escapeHtml(item.level || "info")}">
            <div class="cc-result-title">${escapeHtml(item.title)}</div>
            ${item.meta ? `<div class="cc-result-meta">${escapeHtml(item.meta)}</div>` : ""}
            ${lines}
        </div>
    `;
}

function renderReport(report) {
    latestReport = report;
    const body = document.querySelector("#crosscheck-dialog-body");
    const title = report.mode === "element" ? `요소 검사 · ${report.target}` : "전체 검사 결과";
    document.querySelector("#crosscheck-dialog-title").textContent = title;

    const sections = report.sections.map(section => `
        <section class="cc-section">
            <h3 class="cc-section-title">${escapeHtml(section.title)} (${section.items.length})</h3>
            ${section.items.length ? section.items.map(reportItemHtml).join("") : '<div class="cc-empty">발견된 항목이 없습니다.</div>'}
        </section>
    `).join("");

    body.innerHTML = `
        <div class="cc-summary">
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.extensions}</span><span class="cc-summary-label">로드 확장</span></div>
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.sources}</span><span class="cc-summary-label">CSS 출처</span></div>
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.rules}</span><span class="cc-summary-label">CSS 선언</span></div>
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.issues}</span><span class="cc-summary-label">충돌·주의</span></div>
        </div>
        ${sections}
    `;
    document.querySelector("#crosscheck-overlay").classList.add("cc-open");
}

function closeReport() {
    document.querySelector("#crosscheck-overlay")?.classList.remove("cc-open");
}

async function runFullScan() {
    const button = document.querySelector("#crosscheck-full-scan");
    if (button) button.disabled = true;
    setStatus("확장과 CSS를 검사하는 중…");

    try {
        const css = await collectAllCssRules();
        await nextFrame();
        const paths = discoverLoadedExtensionPaths();
        const manifestData = await loadExtensionManifests(paths);
        const cssConflicts = conflictResultsFromRules(css.rules);
        const manifests = [
            ...manifestResults(manifestData.manifests, paths),
            ...extensionCodeResults(manifestData.manifests),
        ];
        const duplicateIds = duplicateIdResults();
        const keyframes = keyframeResults(css.diagnostics.keyframes);
        const errors = errorResults();
        const readWarnings = [
            ...css.diagnostics.inaccessibleSheets.map(item => ({
                level: "low",
                title: "CSS 내부 규칙 접근 제한",
                meta: item.source.label,
                lines: [{ source: item.source.href || item.source.key, text: item.message }],
            })),
            ...css.diagnostics.parseErrors.map(item => ({
                level: "low",
                title: "등록 CSS 해석 실패",
                meta: item.source.label,
                lines: [{ source: item.source.key, text: item.message }],
            })),
            ...manifestData.failures.map(item => ({
                level: "low",
                title: "확장 manifest 접근 실패",
                meta: item.path,
                lines: [{ source: item.path, text: item.message }],
            })),
            ...manifestData.manifests.filter(item => item.jsError).map(item => ({
                level: "low",
                title: "확장 진입 JS 접근 실패",
                meta: item.manifest.display_name || item.path,
                lines: [{ source: item.path, text: item.jsError }],
            })),
        ];

        const sections = [
            { title: "CSS 충돌 후보", items: cssConflicts },
            { title: "확장 구조 검사", items: manifests },
            { title: "화면 구조 검사", items: [...duplicateIds, ...keyframes] },
            { title: "최근 실행 오류", items: errors },
            { title: "읽기 제한 및 참고", items: readWarnings },
        ];
        const issues = sections.reduce((sum, section) => sum + section.items.length, 0);
        renderReport({
            createdAt: Date.now(),
            mode: "full",
            summary: {
                extensions: paths.length,
                sources: sourceCount(css.rules),
                rules: css.rules.length,
                issues,
            },
            sections,
            metadata: {
                persistentEntries: css.persistent.entryCount,
                activePersistentEntries: css.persistent.activeEntryCount,
                recentStyleChanges: recentStyleChanges.length,
            },
        });
        setStatus(`검사 완료 · 충돌 및 주의 ${issues}개`);
    } catch (error) {
        console.error("[크로스체크] 전체 검사 실패", error);
        setStatus("검사 중 오류가 발생했습니다.");
        globalThis.toastr?.error?.(`크로스체크 검사 실패: ${error?.message || error}`);
    } finally {
        if (button) button.disabled = false;
    }
}

async function inspectElement(element) {
    setStatus(`${elementDescriptor(element)} 검사 중…`);
    try {
        const css = await collectAllCssRules();
        const paths = discoverLoadedExtensionPaths();
        const results = elementConflictResults(element, css.rules);
        const sections = [{ title: "선택 요소 CSS 충돌", items: results }];
        renderReport({
            createdAt: Date.now(),
            mode: "element",
            target: elementDescriptor(element),
            summary: {
                extensions: paths.length,
                sources: sourceCount(css.rules),
                rules: css.rules.length,
                issues: results.length,
            },
            sections,
        });
        setStatus(`요소 검사 완료 · 겹치는 속성 ${results.length}개`);
    } catch (error) {
        console.error("[크로스체크] 요소 검사 실패", error);
        setStatus("요소 검사 중 오류가 발생했습니다.");
    }
}

function clearHighlight() {
    highlightedElement?.classList?.remove("crosscheck-pick-target");
    highlightedElement = null;
}

function stopPicking() {
    if (!picking) return;
    picking = false;
    clearHighlight();
    document.querySelector("#crosscheck-pick-banner")?.classList.remove("cc-open");
    document.removeEventListener("pointerover", handlePickHover, true);
    document.removeEventListener("click", handlePickClick, true);
    document.removeEventListener("keydown", handlePickKey, true);
    setStatus("요소 선택을 취소했습니다.");
}

function handlePickHover(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("#crosscheck-pick-banner, #crosscheck-overlay")) return;
    if (target === highlightedElement) return;
    clearHighlight();
    highlightedElement = target;
    target.classList.add("crosscheck-pick-target");
}

function handlePickClick(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("#crosscheck-pick-banner, #crosscheck-overlay")) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const selected = target;
    picking = false;
    clearHighlight();
    document.querySelector("#crosscheck-pick-banner")?.classList.remove("cc-open");
    document.removeEventListener("pointerover", handlePickHover, true);
    document.removeEventListener("click", handlePickClick, true);
    document.removeEventListener("keydown", handlePickKey, true);
    setTimeout(() => inspectElement(selected), 0);
}

function handlePickKey(event) {
    if (event.key === "Escape") stopPicking();
}

function startPicking() {
    closeReport();
    if (picking) return;
    picking = true;
    setStatus("검사할 화면 요소를 선택하세요.");
    document.querySelector("#crosscheck-pick-banner")?.classList.add("cc-open");
    document.addEventListener("pointerover", handlePickHover, true);
    document.addEventListener("click", handlePickClick, true);
    document.addEventListener("keydown", handlePickKey, true);
}

async function copyLatestReport() {
    if (!latestReport) return;
    try {
        await navigator.clipboard.writeText(buildReportText(latestReport));
        globalThis.toastr?.success?.("크로스체크 결과를 복사했습니다.");
    } catch {
        globalThis.toastr?.error?.("결과를 복사하지 못했습니다.");
    }
}

function addUi() {
    if (document.querySelector("#crosscheck-settings")) return;
    const html = `
        <div id="crosscheck-settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b class="cc-title"><span class="cc-title-emoji">🔀</span><span>크로스체크</span></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="cc-actions">
                        <button id="crosscheck-full-scan" type="button" class="menu_button cc-action">전체 검사</button>
                        <button id="crosscheck-pick" type="button" class="menu_button cc-action">요소 선택</button>
                    </div>
                    <label class="cc-option">
                        <input id="crosscheck-include-disabled" type="checkbox">
                        <span>꺼진 등록 CSS도 잠재 충돌 검사</span>
                    </label>
                    <div id="crosscheck-status" class="cc-status">검사를 시작할 수 있습니다.</div>
                </div>
            </div>
        </div>
    `;
    $("#extensions_settings2").append(html);

    const overlay = document.createElement("div");
    overlay.id = "crosscheck-overlay";
    overlay.innerHTML = `
        <div id="crosscheck-dialog" role="dialog" aria-modal="true" aria-labelledby="crosscheck-dialog-title">
            <div class="cc-dialog-head">
                <div id="crosscheck-dialog-title" class="cc-dialog-title">크로스체크 결과</div>
                <button id="crosscheck-dialog-close" type="button" class="menu_button cc-head-button" aria-label="닫기">×</button>
            </div>
            <div id="crosscheck-dialog-body" class="cc-dialog-body"></div>
            <div class="cc-dialog-foot">
                <button id="crosscheck-copy" type="button" class="menu_button">결과 복사</button>
                <button id="crosscheck-rescan" type="button" class="menu_button">다시 검사</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const banner = document.createElement("div");
    banner.id = "crosscheck-pick-banner";
    banner.innerHTML = `검사할 화면 요소를 누르세요.<button id="crosscheck-pick-cancel" type="button" aria-label="취소">×</button>`;
    document.body.appendChild(banner);

    const settings = getSettings();
    $("#crosscheck-include-disabled").prop("checked", settings.includeDisabledPersistentCss);
    $("#crosscheck-full-scan").on("click", runFullScan);
    $("#crosscheck-pick").on("click", startPicking);
    $("#crosscheck-dialog-close").on("click", closeReport);
    $("#crosscheck-copy").on("click", copyLatestReport);
    $("#crosscheck-rescan").on("click", () => latestReport?.mode === "element" ? startPicking() : runFullScan());
    $("#crosscheck-pick-cancel").on("click", stopPicking);
    $("#crosscheck-overlay").on("click", event => {
        if (event.target?.id === "crosscheck-overlay") closeReport();
    });
    $("#crosscheck-include-disabled").on("change", function () {
        getSettings().includeDisabledPersistentCss = $(this).is(":checked");
        saveSettingsDebounced();
    });
}

function installErrorMonitor() {
    window.addEventListener("error", event => {
        const message = event.message || event.error?.message || "알 수 없는 오류";
        if (/crosscheck/i.test(event.filename || "") || /크로스체크/.test(message)) return;
        recentErrors.push({
            type: "error",
            time: Date.now(),
            message: shortText(message, 300),
            source: event.filename ? `${event.filename}:${event.lineno || 0}` : "",
            stack: shortText(event.error?.stack || "", 500),
        });
        if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
    }, true);

    window.addEventListener("unhandledrejection", event => {
        const reason = event.reason;
        const message = reason?.message || String(reason || "알 수 없는 Promise 오류");
        if (/crosscheck/i.test(reason?.stack || "") || /크로스체크/.test(message)) return;
        recentErrors.push({
            type: "promise",
            time: Date.now(),
            message: shortText(message, 300),
            source: "",
            stack: shortText(reason?.stack || "", 500),
        });
        if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
    });
}

function installStyleMonitor() {
    if (styleMutationObserver) return;
    styleMutationObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element) || !node.matches("style, link[rel='stylesheet']")) continue;
                if (node.dataset.crosscheckParser === "true" || node.id === "crosscheck-style") continue;
                recentStyleChanges.push({
                    time: Date.now(),
                    type: node.tagName.toLowerCase(),
                    source: node.getAttribute("href") || node.id || node.dataset.extension || "동적 인라인 CSS",
                });
                if (recentStyleChanges.length > 50) recentStyleChanges.shift();
            }
        }
    });
    styleMutationObserver.observe(document.head, { childList: true });
}

installErrorMonitor();

jQuery(async () => {
    getSettings();
    addUi();
    installStyleMonitor();
});
