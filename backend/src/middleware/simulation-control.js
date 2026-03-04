function requireSimulationControlKey(req, res, next) {
  const configuredKey = process.env.SIMULATION_CONTROL_KEY;
  if (!configuredKey || !configuredKey.trim()) {
    return res.status(503).json({
      message: "Chave de controle de simulacao nao configurada no servidor.",
    });
  }

  const providedKey = String(req.headers["x-simulacao-chave"] || "").trim();
  if (!providedKey) {
    return res.status(401).json({ message: "Chave de controle ausente." });
  }
  if (providedKey !== configuredKey.trim()) {
    return res.status(403).json({ message: "Chave de controle invalida." });
  }
  return next();
}

module.exports = {
  requireSimulationControlKey,
};
