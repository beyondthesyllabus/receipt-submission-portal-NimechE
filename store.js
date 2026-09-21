"use strict";

// All database and photo-storage work lives here, so server.js never touches Supabase directly.
// Data is kept in Supabase (outside Vercel), so redeploying or restarting never deletes it.

const { createClient } = require("@supabase/supabase-js");

const BUCKET = "receipts";
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const configured = Boolean(url && key);
const sb = configured
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

function fail(error, what) {
    const e = new Error(`${what}: ${error.message || error}`);
    e.code = error.code;
    throw e;
}

const STUDENT_COLS = "id,name,reg_number,created_at";
const WITH_RECEIPTS = `${STUDENT_COLS},receipts(id,file,original_name,created_at)`;
const PAGE = 1000; // Supabase returns at most 1000 rows per request

function shape(s) {
    const receipts = (s.receipts || []).map((r) => ({ ...r, kind: "image" }));
    return { ...s, receipts, receipt_count: receipts.length };
}

// ---- Students ---------------------------------------------------------------
async function getStudentByReg(reg) {
    const { data, error } = await sb
        .from("students")
        .select(STUDENT_COLS)
        .eq("reg_number", reg)
        .maybeSingle();
    if (error) fail(error, "getStudentByReg");
    return data;
}

// Returns the new student, or null if that registration number already exists.
async function createStudent(name, reg) {
    const { data, error } = await sb
        .from("students")
        .insert({ name, reg_number: reg })
        .select(STUDENT_COLS)
        .single();
    if (error) {
        if (error.code === "23505") return null; // unique violation
        fail(error, "createStudent");
    }
    return data;
}

async function deleteStudent(id) {
    const { error } = await sb.from("students").delete().eq("id", id);
    if (error) fail(error, "deleteStudent");
}

async function getStudentWithReceipts(id) {
    const { data, error } = await sb
        .from("students")
        .select(WITH_RECEIPTS)
        .eq("id", id)
        .maybeSingle();
    if (error) fail(error, "getStudentWithReceipts");
    return data ? shape(data) : null;
}

// All students (oldest first) with their receipts. `ids` optionally limits the list.
async function listStudents(ids) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
        let query = sb
            .from("students")
            .select(WITH_RECEIPTS)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .order("id", { referencedTable: "receipts", ascending: true });
        if (ids && ids.length) query = query.in("id", ids);
        const { data, error } = await query.range(from, from + PAGE - 1);
        if (error) fail(error, "listStudents");
        out.push(...data);
        if (data.length < PAGE) break;
    }
    return out.map(shape);
}

// ---- Receipts ---------------------------------------------------------------
async function addReceipt(studentId, file, originalName) {
    const { error } = await sb
        .from("receipts")
        .insert({ student_id: studentId, file, original_name: originalName });
    if (error) fail(error, "addReceipt");
}

async function getReceipt(id) {
    const { data, error } = await sb
        .from("receipts")
        .select("id,student_id,file,original_name,created_at")
        .eq("id", id)
        .maybeSingle();
    if (error) fail(error, "getReceipt");
    return data;
}

async function deleteReceipt(id) {
    const { error } = await sb.from("receipts").delete().eq("id", id);
    if (error) fail(error, "deleteReceipt");
}

async function countReceipts(studentId) {
    const { count, error } = await sb
        .from("receipts")
        .select("id", { count: "exact", head: true })
        .eq("student_id", studentId);
    if (error) fail(error, "countReceipts");
    return count || 0;
}

// ---- Photo files ------------------------------------------------------------
async function uploadFile(name, buffer) {
    const { error } = await sb.storage
        .from(BUCKET)
        .upload(name, buffer, { contentType: "image/jpeg", upsert: false });
    if (error) fail(error, "uploadFile");
}

async function downloadFile(name) {
    const { data, error } = await sb.storage.from(BUCKET).download(name);
    if (error) fail(error, "downloadFile");
    return Buffer.from(await data.arrayBuffer());
}

async function removeFiles(names) {
    if (!names || names.length === 0) return;
    const { error } = await sb.storage.from(BUCKET).remove(names);
    if (error) console.error("removeFiles:", error.message);
}

module.exports = {
    configured,
    getStudentByReg,
    createStudent,
    deleteStudent,
    getStudentWithReceipts,
    listStudents,
    addReceipt,
    getReceipt,
    deleteReceipt,
    countReceipts,
    uploadFile,
    downloadFile,
    removeFiles,
};