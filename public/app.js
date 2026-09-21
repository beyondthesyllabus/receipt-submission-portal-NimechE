(function () {
  "use strict";

  var MAX_FILES = 1;
  var MAX_ORIGINAL_BYTES = 20 * 1024 * 1024; // photo picked from the phone
  var MAX_UPLOAD_BYTES = 4 * 1024 * 1024;    // after shrinking (Vercel allows about 4.5 MB)
  var MAX_SIDE = 1600;                        // longest side in pixels after shrinking

  var form = document.getElementById("form");
  var nameEl = document.getElementById("name");
  var regEl = document.getElementById("reg");
  var drop = document.getElementById("drop");
  var fileInput = document.getElementById("files");
  var listEl = document.getElementById("fileList");
  var errorEl = document.getElementById("error");
  var submitBtn = document.getElementById("submit");
  var formView = document.getElementById("formView");
  var doneView = document.getElementById("doneView");
  var doneText = document.getElementById("doneText");

  var files = [];
  var previews = [];

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function fmtSize(b) {
    return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  }

  // Shrinks the photo in the browser so it uploads fast and stays under the size limit.
  function shrink(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            resolve(blob || file);
          }, "image/jpeg", 0.85);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  function addFiles(list) {
    showError("");
    Array.prototype.forEach.call(list, function (f) {
      var okType = /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
      if (!okType) return showError('"' + f.name + '" is not a photo. Attach a clear JPG, PNG or WEBP image.');
      if (f.size > MAX_ORIGINAL_BYTES) return showError('"' + f.name + '" is too large. Choose a photo under 20 MB.');
      if (MAX_FILES === 1) files = []; // choosing a new photo replaces the old one
      else if (files.length >= MAX_FILES) return showError("You can attach at most " + MAX_FILES + " photos.");
      files.push(f);
    });
    renderList();
  }

  function renderList() {
    previews.forEach(function (u) { URL.revokeObjectURL(u); });
    previews = [];
    listEl.innerHTML = "";
    files.forEach(function (f, i) {
      var li = document.createElement("li");
      var thumb = document.createElement("img");
      var url = URL.createObjectURL(f);
      previews.push(url);
      thumb.src = url;
      thumb.alt = "";
      var meta = document.createElement("span");
      meta.className = "meta";
      var nm = document.createElement("span");
      nm.className = "fname";
      nm.textContent = f.name;
      var sz = document.createElement("span");
      sz.className = "fsize";
      sz.textContent = fmtSize(f.size);
      meta.appendChild(nm);
      meta.appendChild(sz);
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "remove";
      rm.setAttribute("aria-label", "Remove " + f.name);
      rm.textContent = "Remove";
      rm.addEventListener("click", function () {
        files.splice(i, 1);
        renderList();
      });
      li.appendChild(thumb);
      li.appendChild(meta);
      li.appendChild(rm);
      listEl.appendChild(li);
    });
  }

  drop.addEventListener("click", function () { fileInput.click(); });
  drop.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", function () {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.remove("over");
    });
  });
  drop.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  function resetButton() {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit receipts";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    showError("");

    var name = nameEl.value.replace(/\s+/g, " ").trim();
    var reg = regEl.value.replace(/\s+/g, "").toUpperCase();

    if (name.length < 3) { nameEl.focus(); return showError("Enter your full name."); }
    if (!/^[A-Z0-9\/\-_.]{3,30}$/.test(reg)) { regEl.focus(); return showError("Enter a valid registration number."); }

    if (reg.indexOf("ME") === -1) {
      regEl.focus();
      return showError("Invalid registration number. Registration number must belong to Mechanical Engineering (must include 'ME', e.g. 22/EG/ME/001).");
    }

    if (files.length === 0) return showError("Attach your receipt photo.");

    submitBtn.disabled = true;
    submitBtn.textContent = "Preparing photo\u2026";

    shrink(files[0])
      .then(function (blob) {
        if (blob.size > MAX_UPLOAD_BYTES) throw new Error("The photo is still too large. Please choose a smaller photo.");

        var fd = new FormData();
        fd.append("name", name);
        fd.append("regNumber", reg);
        var baseName = files[0].name.replace(/\.[^.]+$/, "") || "receipt";
        fd.append("receipts", blob, baseName + ".jpg");

        submitBtn.textContent = "Uploading\u2026";
        return fetch("/api/submit", { method: "POST", body: fd });
      })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || "Upload failed. Please try again.");
        var n = res.data.count;
        doneText.textContent =
          n + (n === 1 ? " receipt was" : " receipts were") + " saved for " + res.data.name +
          " (" + res.data.regNumber + ").";
        formView.hidden = true;
        doneView.hidden = false;
      })
      .catch(function (err) {
        showError(err.message === "Failed to fetch" ? "No connection. Check your network and try again." : err.message);
      })
      .then(resetButton);
  });

  document.getElementById("again").addEventListener("click", function () {
    files = [];
    renderList();
    nameEl.value = "";
    regEl.value = "";
    doneView.hidden = true;
    formView.hidden = false;
    nameEl.focus();
  });
})();