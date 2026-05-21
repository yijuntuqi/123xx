const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.static('public'));

// AI聊天API端点
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        
        // 首先尝试使用 ChatAnywhere API
        try {
            const response = await axios.post(process.env.CHATANYWHERE_API_URL, {
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content: "你是一个AI学习助手，专门帮助学生学习人工智能相关知识。请用中文回答，回答要专业且易懂。"
                    },
                    {
                        role: "user",
                        content: message
                    }
                ],
                temperature: 0.7
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.CHATANYWHERE_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.json({ 
                success: true, 
                reply: response.data.choices[0].message.content,
                model: "ChatAnywhere"
            });
        } catch (chatAnywhereError) {
            console.log('ChatAnywhere API 调用失败，尝试使用 Kimi API');
            
            // 如果 ChatAnywhere 失败，使用 Kimi API
            const kimiResponse = await axios.post(`${process.env.KIMI_BASE_URL}/chat/completions`, {
                model: process.env.KIMI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "你是一个AI学习助手，专门帮助学生学习人工智能相关知识。请用中文回答，回答要专业且易懂。"
                    },
                    {
                        role: "user",
                        content: message
                    }
                ],
                temperature: 0.7
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.KIMI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.json({ 
                success: true, 
                reply: kimiResponse.data.choices[0].message.content,
                model: "Kimi"
            });
        }
    } catch (error) {
        console.error('AI API 调用错误:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'AI服务暂时不可用，请稍后再试' 
        });
    }
});

// 获取AI学习资源
app.get('/api/resources', (req, res) => {
    const resources = {
        courses: [
            { name: "机器学习", platform: "Coursera", link: "https://www.coursera.org/learn/machine-learning" },
            { name: "深度学习", platform: "fast.ai", link: "https://course.fast.ai/" },
            { name: "自然语言处理", platform: "Stanford Online", link: "https://online.stanford.edu/courses" }
        ],
        tools: [
            { name: "PyTorch", description: "深度学习框架", link: "https://pytorch.org/" },
            { name: "TensorFlow", description: "机器学习平台", link: "https://www.tensorflow.org/" },
            { name: "Hugging Face", description: "NLP模型库", link: "https://huggingface.co/" }
        ],
        papers: [
            { name: "Attention Is All You Need", year: 2017, description: "Transformer架构开创性论文" },
            { name: "BERT", year: 2018, description: "预训练语言模型" },
            { name: "GPT系列", year: 2018-2023, description: "生成式预训练模型演进" }
        ]
    };
    res.json(resources);
});

// 所有其他路由返回首页
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`AI Learning Hub 服务器运行在 http://localhost:${PORT}`);
});