import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const STORAGE_KEY = "hospital_demo_auth";

export const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
  timeout: 30000,
});

export function getStoredAuth() {
  const value = localStorage.getItem(STORAGE_KEY);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function setStoredAuth(payload) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function clearStoredAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

export function setApiToken(token) {
  if (!token) {
    delete api.defaults.headers.common.Authorization;
    return;
  }
  api.defaults.headers.common.Authorization = `Bearer ${token}`;
}

setApiToken(getStoredAuth()?.token);
