const { evaluateFault } = require("../services/chaos");
const { recordChaos } = require("../services/metrics");

function faultInjection(req, res, next) {
  const decision = evaluateFault(req.path || "/");

  const continueExecution = () => {
    if (decision.injectError) {
      recordChaos("fault_injected_http_500", "started");
      return res.status(500).json({
        message: "Falha simulada para teste de observabilidade.",
      });
    }
    return next();
  };

  if (decision.delayMs > 0) {
    setTimeout(continueExecution, decision.delayMs);
    return undefined;
  }

  return continueExecution();
}

module.exports = {
  faultInjection,
};
