(function () {
  "use strict";

  var loginView = document.getElementById("loginView");
  var dashView = document.getElementById("dashView");
  var loginForm = document.getElementById("loginForm");
  var loginError = document.getElementById("loginError");
  var rowsEl = document.getElementById("rows");
  var emptyEl = document.getElementById("empty");
  var summaryEl = document.getElementById("summary");
  var searchEl = document.getElementById("search");
  var selectAll = document.getElementById("selectAll");
  var hintEl = document.getElementById("hint");
  var tabsEl = document.getElementById("tabs");
  var btnFull = document.getElementById("btnFull");
  var btnPrint = document.getElementById("btnPrint");
  var btnTable = document.getElementById("btnTable");

  var students = [];
  var selected = new Set();
  var expanded = new Set();
  var activeYear = "all"; // "all" or a prefix such as "22"

  var DEFAULT_HINT =
    "Download PDF and Print include the register table followed by every receipt. They use all students unless you tick rows.";

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") el.className = attrs[k];
        else if (k === "text") el.textContent = attrs[k];
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
        else el.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { showLogin(); throw new Error("Please sign in."); }
        if (!r.ok) throw new Error(data.error || "Request failed.");
        return data;
      });
    });
  }

  // Nigerian time, 12-hour clock
  function fmtDate(iso) {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: "Africa/Lagos", day: "2-digit", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    });
  }

  // ---- Groups (22/EG/ME/... and 23/EG/ME/... are kept apart) ---------------
  function yearOf(reg) {
    var m = /^(\d{1,4})\//.exec(reg);
    return m ? m[1] : "Other";
  }

  function yearLabel(y) {
    return y === "Other" ? "Other" : y + "/\u2026";
  }

  function byReg(a, b) {
    return a.reg_number.localeCompare(b.reg_number, undefined, { numeric: true });
  }

  function yearCounts() {
    var counts = {};
    var order = [];
    students.forEach(function (s) {
      var y = yearOf(s.reg_number);
      if (!(y in counts)) { counts[y] = 0; order.push(y); }
      counts[y]++;
    });
    return { counts: counts, order: order };
  }

  function renderTabs() {
    var yc = yearCounts();
    tabsEl.innerHTML = "";
    tabsEl.hidden = yc.order.length < 2;

    function addTab(key, text, n) {
      var on = activeYear === key;
      tabsEl.appendChild(
        h("button", {
          class: "tab" + (on ? " active" : ""),
          type: "button",
          "aria-pressed": String(on),
          onclick: function () { activeYear = key; render(); }
        }, text + " ", h("span", { class: "count", text: String(n) }))
      );
    }

    addTab("all", "All", students.length);
    yc.order.forEach(function (y) { addTab(y, yearLabel(y), yc.counts[y]); });
  }

  // ---- Auth ---------------------------------------------------------------
  function showLogin() {
    dashView.hidden = true;
    loginView.hidden = false;
    document.getElementById("password").focus();
  }

  function showDash() {
    loginView.hidden = true;
    dashView.hidden = false;
    load();
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.hidden = true;
    var pw = document.getElementById("password");
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw.value })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || "Could not sign in.");
        pw.value = "";
        showDash();
      })
      .catch(function (err) {
        loginError.textContent = err.message;
        loginError.hidden = false;
      });
  });

  document.getElementById("logout").addEventListener("click", function () {
    fetch("/api/admin/logout", { method: "POST" }).then(showLogin);
  });

  // ---- Data ---------------------------------------------------------------
  function load() {
    return api("/api/admin/students").then(function (d) {
      students = d.students.slice().sort(byReg);
      var ids = new Set(students.map(function (s) { return s.id; }));
      selected.forEach(function (id) { if (!ids.has(id)) selected.delete(id); });
      if (activeYear !== "all" && !(activeYear in yearCounts().counts)) activeYear = "all";
      render();
    }).catch(function () { });
  }

  function inGroup(s) {
    return activeYear === "all" || yearOf(s.reg_number) === activeYear;
  }

  function visible() {
    var term = searchEl.value.trim().toLowerCase();
    return students.filter(function (s) {
      if (!inGroup(s)) return false;
      if (!term) return true;
      return s.name.toLowerCase().indexOf(term) !== -1 || s.reg_number.toLowerCase().indexOf(term) !== -1;
    });
  }

  function render() {
    var list = visible();
    var yc = yearCounts();
    var totalReceipts = students.reduce(function (n, s) { return n + s.receipt_count; }, 0);
    summaryEl.textContent = students.length + (students.length === 1 ? " student, " : " students, ") +
      totalReceipts + (totalReceipts === 1 ? " receipt" : " receipts");

    renderTabs();

    rowsEl.innerHTML = "";
    emptyEl.hidden = list.length !== 0;
    emptyEl.textContent = students.length === 0 ? "No submissions yet." : "No matches.";

    var lastYear = null;
    var sn = 0;

    list.forEach(function (s) {
      var y = yearOf(s.reg_number);

      if (y !== lastYear) {
        // In the "All" view, each group gets a heading row and numbering starts again at 1.
        if (activeYear === "all") {
          var n = yc.counts[y];
          rowsEl.appendChild(
            h("tr", { class: "group" },
              h("td", {
                colspan: "7",
                text: (y === "Other" ? "Other registration numbers" : "Registration numbers starting with " + y + "/") +
                  "  \u00b7  " + n + (n === 1 ? " student" : " students")
              })
            )
          );
        }
        lastYear = y;
        sn = 0;
      }
      sn++;

      var cb = h("input", { type: "checkbox", "aria-label": "Select " + s.name });
      cb.checked = selected.has(s.id);
      cb.addEventListener("change", function () {
        if (cb.checked) selected.add(s.id); else selected.delete(s.id);
        updateExportUi();
      });

      var open = expanded.has(s.id);
      var tr = h("tr", null,
        h("td", { class: "chk" }, cb),
        h("td", { class: "sn", text: String(sn) }),
        h("td", { class: "name", text: s.name }),
        h("td", { class: "reg", text: s.reg_number }),
        h("td", { class: "num", text: String(s.receipt_count) }),
        h("td", { class: "date", text: fmtDate(s.created_at) }),
        h("td", { class: "rowactions" },
          h("button", {
            class: "link", type: "button", text: open ? "Hide receipts" : "View receipts",
            onclick: function () {
              if (expanded.has(s.id)) expanded.delete(s.id); else expanded.add(s.id);
              render();
            }
          }),
          h("button", {
            class: "link", type: "button", text: "Print",
            onclick: function () { window.open("/api/admin/export.pdf?ids=" + s.id, "_blank"); }
          }),
          h("button", {
            class: "link danger", type: "button", text: "Delete",
            onclick: function () {
              if (!confirm("Delete " + s.name + " (" + s.reg_number + ") and all their receipts? This cannot be undone.")) return;
              api("/api/admin/students/" + s.id, { method: "DELETE" }).then(load).catch(alertErr);
            }
          })
        )
      );
      rowsEl.appendChild(tr);

      if (open) {
        var grid = h("div", { class: "thumbs" });
        s.receipts.forEach(function (r, i) {
          var href = "/api/admin/receipts/" + r.id + "/file";
          var face = r.kind === "image"
            ? h("img", { src: href, alt: "Receipt " + (i + 1), loading: "lazy" })
            : h("span", { class: "pdfchip big", text: "PDF" });
          grid.appendChild(h("figure", null,
            h("a", { href: href, target: "_blank", rel: "noopener" }, face),
            h("figcaption", null,
              h("span", { text: "Receipt " + (i + 1) }),
              h("button", {
                class: "link danger", type: "button", text: "Delete",
                onclick: function () {
                  if (!confirm("Delete this receipt?")) return;
                  api("/api/admin/receipts/" + r.id, { method: "DELETE" }).then(load).catch(alertErr);
                }
              })
            )
          ));
        });
        rowsEl.appendChild(h("tr", { class: "detail" }, h("td", { colspan: "7" }, grid)));
      }
    });

    updateExportUi();
  }

  function alertErr(e) { alert(e.message); }

  function updateExportUi() {
    var list = visible();
    selectAll.checked = list.length > 0 && list.every(function (s) { return selected.has(s.id); });
    var n = selected.size;
    var suffix = "";
    if (n) suffix = " (" + n + " selected)";
    else if (activeYear !== "all") suffix = " (" + yearLabel(activeYear) + " only)";
    btnFull.textContent = "Download PDF" + suffix;
    btnPrint.textContent = "Print" + suffix;
    btnTable.textContent = "Register only" + suffix;
    if (n) hintEl.textContent = n + " selected. Clear the ticks to export the whole list.";
    else if (activeYear !== "all")
      hintEl.textContent = "Downloads and prints use only the " + yearLabel(activeYear) +
        " students. Tick rows to choose specific students.";
    else hintEl.textContent = DEFAULT_HINT;
  }

  selectAll.addEventListener("change", function () {
    visible().forEach(function (s) {
      if (selectAll.checked) selected.add(s.id); else selected.delete(s.id);
    });
    render();
  });

  searchEl.addEventListener("input", render);

  // ---- Exports ------------------------------------------------------------
  // Ticked rows win; otherwise the open group (22/..., 23/...); otherwise everyone.
  function exportIds() {
    if (selected.size) return Array.from(selected);
    if (activeYear !== "all") {
      return students.filter(inGroup).map(function (s) { return s.id; });
    }
    return null;
  }

  function exportUrl(path, download) {
    var params = [];
    var ids = exportIds();
    if (ids) params.push("ids=" + ids.join(","));
    if (download) params.push("download=1");
    return path + (params.length ? "?" + params.join("&") : "");
  }

  function download(url) {
    var a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  btnFull.addEventListener("click", function () { download(exportUrl("/api/admin/export.pdf", true)); });
  btnPrint.addEventListener("click", function () { window.open(exportUrl("/api/admin/export.pdf", false), "_blank"); });
  btnTable.addEventListener("click", function () { download(exportUrl("/api/admin/table.pdf", true)); });
  document.getElementById("btnCsv").addEventListener("click", function () { download("/api/admin/export.csv"); });

  // ---- Refresh button -----------------------------------------------------
  var btnRefresh = document.getElementById("btnRefresh");
  var updatedEl = document.getElementById("updated");

  function stamp() {
    updatedEl.textContent = "Last updated " + new Date().toLocaleTimeString("en-GB", {
      timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit", hour12: true
    });
  }

  btnRefresh.addEventListener("click", function () {
    btnRefresh.disabled = true;
    btnRefresh.textContent = "Refreshing\u2026";
    load().then(function () {
      stamp();
      btnRefresh.disabled = false;
      btnRefresh.textContent = "Refresh";
    });
  });

  // ---- Boot ---------------------------------------------------------------
  fetch("/api/admin/me")
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.signedIn) showDash(); else showLogin(); })
    .catch(showLogin);
})();