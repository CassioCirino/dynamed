const jwt = require("jsonwebtoken");

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token ausente." });
  }

  const token = authHeader.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Token invalido." });
  }
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Usuario nao autenticado." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Perfil sem permissao para esta acao." });
    }
    return next();
  };
}

module.exports = {
  authenticate,
  authorize,
};
