const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getPosts, createPost, deletePost,
  toggleLike, getComments, addComment, deleteComment,
} = require('../controllers/shoutboardController');

router.get('/', authenticate, getPosts);
router.post('/', authenticate, createPost);
router.delete('/:id', authenticate, deletePost);
router.post('/:id/like', authenticate, toggleLike);
router.get('/:id/comments', authenticate, getComments);
router.post('/:id/comments', authenticate, addComment);
router.delete('/:id/comments/:commentId', authenticate, deleteComment);

module.exports = router;
