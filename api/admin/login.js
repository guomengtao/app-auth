module.exports = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: "Username/password login has been disabled. Please use Vercel Deployment Protection authentication.",
  });
};