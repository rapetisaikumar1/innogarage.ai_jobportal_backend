const prisma = require('../config/database');

const userSelect = {
  id: true,
  fullName: true,
  avatarUrl: true,
  registrationNumber: true,
  jobRole: true,
};

// Get all posts with comments count and likes count
const getPosts = async (req, res) => {
  try {
    const posts = await prisma.shoutPost.findMany({
      include: {
        user: { select: userSelect },
        _count: { select: { comments: true, likes: true } },
        likes: { where: { userId: req.user.id }, select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = posts.map((post) => ({
      ...post,
      likesCount: post._count.likes,
      commentsCount: post._count.comments,
      isLiked: post.likes.length > 0,
      _count: undefined,
      likes: undefined,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ message: 'Failed to fetch posts' });
  }
};

// Create a post
const createPost = async (req, res) => {
  try {
    const { content, tag } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Content is required' });
    }

    const post = await prisma.shoutPost.create({
      data: {
        userId: req.user.id,
        content: content.trim(),
        tag: tag || null,
      },
      include: {
        user: { select: userSelect },
        _count: { select: { comments: true, likes: true } },
      },
    });

    res.status(201).json({
      ...post,
      likesCount: 0,
      commentsCount: 0,
      isLiked: false,
      _count: undefined,
    });
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ message: 'Failed to create post' });
  }
};

// Delete own post
const deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    const post = await prisma.shoutPost.findUnique({ where: { id } });

    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (post.userId !== req.user.id && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    await prisma.shoutPost.delete({ where: { id } });
    res.json({ message: 'Post deleted' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ message: 'Failed to delete post' });
  }
};

// Toggle like on a post
const toggleLike = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.shoutLike.findUnique({
      where: { postId_userId: { postId: id, userId: req.user.id } },
    });

    if (existing) {
      await prisma.shoutLike.delete({ where: { id: existing.id } });
      const count = await prisma.shoutLike.count({ where: { postId: id } });
      return res.json({ liked: false, likesCount: count });
    }

    await prisma.shoutLike.create({
      data: { postId: id, userId: req.user.id },
    });
    const count = await prisma.shoutLike.count({ where: { postId: id } });
    res.json({ liked: true, likesCount: count });
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({ message: 'Failed to toggle like' });
  }
};

// Get comments for a post (with nested replies)
const getComments = async (req, res) => {
  try {
    const { id } = req.params;

    const comments = await prisma.shoutComment.findMany({
      where: { postId: id, parentId: null },
      include: {
        user: { select: userSelect },
        replies: {
          include: {
            user: { select: userSelect },
            replies: {
              include: { user: { select: userSelect } },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(comments);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ message: 'Failed to fetch comments' });
  }
};

// Add a comment (or reply)
const addComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parentId } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Comment content is required' });
    }

    const comment = await prisma.shoutComment.create({
      data: {
        postId: id,
        userId: req.user.id,
        content: content.trim(),
        parentId: parentId || null,
      },
      include: {
        user: { select: userSelect },
        replies: { include: { user: { select: userSelect } } },
      },
    });

    res.status(201).json(comment);
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ message: 'Failed to add comment' });
  }
};

// Delete own comment
const deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const comment = await prisma.shoutComment.findUnique({ where: { id: commentId } });

    if (!comment) return res.status(404).json({ message: 'Comment not found' });
    if (comment.userId !== req.user.id && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    await prisma.shoutComment.delete({ where: { id: commentId } });
    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ message: 'Failed to delete comment' });
  }
};

module.exports = { getPosts, createPost, deletePost, toggleLike, getComments, addComment, deleteComment };
