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
  var btnFull = document.getElementById("btnFull");
  var btnPrint = document.getElementById("btnPrint");
  var btnTable = document.getElementById("btnTable");
  var btnDeleteSelected = document.getElementById("btnDeleteSelected");

  var students = [];
  var selected = new Set();
  var expanded = new Set();

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

  function fmtDate(iso) {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: "Africa/Lagos", day: "2-digit", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    });
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
      students = d.students;
      var ids = new Set(students.map(function (s) { return s.id; }));
      selected.forEach(function (id) { if (!ids.has(id)) selected.delete(id); });
      render();
    }).catch(function () { });
  }

  function visible() {
    var term = searchEl.value.trim().toLowerCase();
    if (!term) return students;
    return students.filter(function (s) {
      return s.name.toLowerCase().indexOf(term) !== -1 || s.reg_number.toLowerCase().indexOf(term) !== -1;
    });
  }

  function render() {
    var list = visible();
    var totalReceipts = students.reduce(function (n, s) { return n + s.receipt_count; }, 0);
    summaryEl.textContent = students.length + (students.length === 1 ? " student, " : " students, ") +
      totalReceipts + (totalReceipts === 1 ? " receipt" : " receipts");

    rowsEl.innerHTML = "";
    emptyEl.hidden = list.length !== 0;
    emptyEl.textContent = students.length === 0 ? "No submissions yet." : "No matches.";

    list.forEach(function (s) {
      var sn = students.indexOf(s) + 1;
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

        h("td", { class: "date", text: fmtDate(s.created_at) }),
        h("td", { class: "rowactions" },
          h("button", {
            class: "link", type: "button", text: open ? "Hide" : "View",
            onclick: function () {
              if (expanded.has(s.id)) expanded.delete(s.id); else expanded.add(s.id);
              render();
            }
          }),
          h("button", {
            class: "link btn-dl", type: "button", text: "Download PDF",
            onclick: function () { download(exportUrl("/api/admin/export.pdf?ids=" + s.id, true)); }
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
    var suffix = n ? " (" + n + " selected)" : "";
    btnFull.textContent = "Download PDF" + suffix;
    btnPrint.textContent = "Print" + suffix;
    btnTable.textContent = "Register only" + suffix;
    btnDeleteSelected.hidden = n === 0;
    btnDeleteSelected.textContent = "Delete selected (" + n + ")";
    hintEl.textContent = n
      ? n + " selected. Ticking rows lets you download, print, or delete specific submissions."
      : "Download PDF and Print include the register table followed by every receipt. They use all students unless you tick rows.";
  }

  selectAll.addEventListener("change", function () {
    visible().forEach(function (s) {
      if (selectAll.checked) selected.add(s.id); else selected.delete(s.id);
    });
    render();
  });

  searchEl.addEventListener("input", render);

  btnDeleteSelected.addEventListener("click", function () {
    var n = selected.size;
    if (!n) return;
    if (!confirm("Are you sure you want to delete " + n + " selected submission" + (n === 1 ? "" : "s") + "? This will permanently remove their records and all attached receipt photos.")) return;
    var ids = Array.from(selected);
    Promise.all(ids.map(function (id) {
      return api("/api/admin/students/" + id, { method: "DELETE" });
    }))
      .then(function () {
        selected.clear();
        load();
      })
      .catch(alertErr);
  });

  // ---- Exports ------------------------------------------------------------
  function exportUrl(path, download) {
    var hasQuery = path.indexOf("?") !== -1;
    var params = [];
    if (!hasQuery && selected.size) params.push("ids=" + Array.from(selected).join(","));
    if (download && path.indexOf("download=") === -1) params.push("download=1");
    if (!params.length) return path;
    return path + (hasQuery ? "&" : "?") + params.join("&");
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
