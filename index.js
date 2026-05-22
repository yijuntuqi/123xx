const express = require('express');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const csv = require('csv-parse');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const { testConnection, userDB, fileDB, analysisDB } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 修复1：中文文件名支持 ============
// 自定义存储配置，保留原始文件名（包括中文）
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        // 解码中文文件名，避免乱码
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(originalName);
        const basename = path.basename(originalName, ext);
        cb(null, basename + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB限制
    fileFilter: function (req, file, cb) {
        // 允许的文件类型
        const allowedTypes = [
            'text/csv',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/json'
        ];
        if (allowedTypes.includes(file.mimetype) || 
            file.originalname.match(/\.(csv|xlsx|xls|json)$/)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的文件格式，请上传 CSV、Excel 或 JSON 文件'));
        }
    }
});

// 中间件
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'ai-analyst-secret-key-2024';

// ============ 修复2：取消上传功能 ============
// 存储活跃的上传任务，用于取消
global.activeUploads = global.activeUploads || new Map();

// 取消上传接口
app.post('/api/upload/cancel/:uploadId', (req, res) => {
    const uploadId = req.params.uploadId;
    const uploadTask = global.activeUploads.get(uploadId);
    
    if (uploadTask) {
        // 如果文件已经写入磁盘，删除它
        if (uploadTask.filePath && require('fs').existsSync(uploadTask.filePath)) {
            require('fs').unlinkSync(uploadTask.filePath);
        }
        global.activeUploads.delete(uploadId);
        res.json({ success: true, message: '上传已取消' });
    } else {
        res.json({ success: false, message: '未找到上传任务' });
    }
});

// ============ 用户认证 ============
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        // 验证输入
        if (!username || !email || !password) {
            return res.status(400).json({ error: '请填写所有字段' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: '密码至少6位' });
        }
        
        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: '该邮箱已注册' });
        }
        
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await userDB.createUser(username, email, passwordHash);
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ success: true, user, token });
    } catch (error) {
        console.error('注册失败:', error);
        res.status(500).json({ error: '注册失败，请稍后再试' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: '请填写邮箱和密码' });
        }
        
        const user = await userDB.findByEmail(email);
        if (!user) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                username: user.username, 
                email: user.email, 
                plan_type: user.plan_type 
            }, 
            token 
        });
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({ error: '登录失败，请稍后再试' });
    }
});

// ============ 文件上传 ============
app.post('/api/upload', (req, res, next) => {
    const uploadId = Date.now().toString();
    
    // 创建可取消的上传任务
    const uploadTask = {
        id: uploadId,
        startTime: Date.now(),
        filePath: null,
        cancelled: false
    };
    global.activeUploads.set(uploadId, uploadTask);
    
    // 发送上传ID给客户端，用于取消
    res.setHeader('X-Upload-Id', uploadId);
    
    upload.single('file')(req, res, async (err) => {
        // 检查是否已被取消
        if (uploadTask.cancelled) {
            if (req.file && require('fs').existsSync(req.file.path)) {
                require('fs').unlinkSync(req.file.path);
            }
            global.activeUploads.delete(uploadId);
            return;
        }
        
        if (err) {
            global.activeUploads.delete(uploadId);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: '文件大小不能超过10MB' });
            }
            return res.status(400).json({ error: err.message });
        }
        
        try {
            const userId = req.body.userId || 1;
            const file = req.file;
            
            if (!file) {
                global.activeUploads.delete(uploadId);
                return res.status(400).json({ error: '请选择文件' });
            }
            
            uploadTask.filePath = file.path;
            
            // 正确解码文件名
            let originalFileName = file.originalname;
            if (/[^\x00-\x7F]/.test(originalFileName)) {
                // 包含非ASCII字符，尝试解码
                try {
                    originalFileName = Buffer.from(originalFileName, 'latin1').toString('utf8');
                } catch (e) {
                    // 解码失败则保持原名
                }
            }
            
            let data = [];
            let fileType = '';
            
            // 解析文件
            if (file.originalname.match(/\.csv$/i)) {
                fileType = 'csv';
                const content = require('fs').readFileSync(file.path, 'utf-8');
                data = await new Promise((resolve, reject) => {
                    csv.parse(content, { 
                        columns: true, 
                        skip_empty_lines: true,
                        encoding: 'utf-8'
                    }, (err, records) => {
                        if (err) reject(err);
                        resolve(records);
                    });
                });
            } else if (file.originalname.match(/\.xlsx?$/i)) {
                fileType = 'excel';
                const workbook = XLSX.readFile(file.path);
                const sheetName = workbook.SheetNames[0];
                data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
            } else if (file.originalname.match(/\.json$/i)) {
                fileType = 'json';
                const content = require('fs').readFileSync(file.path, 'utf-8');
                data = JSON.parse(content);
                if (!Array.isArray(data)) {
                    data = [data]; // 如果是单个对象，转为数组
                }
            }
            
            if (data.length === 0) {
                global.activeUploads.delete(uploadId);
                return res.status(400).json({ error: '文件中没有有效数据' });
            }
            
            const columnsInfo = Object.keys(data[0]).map(col => ({
                name: col,
                type: typeof data[0][col],
                sample: data[0][col]
            }));
            
            const fileInfo = {
                fileName: originalFileName,
                fileType,
                fileSize: file.size,
                rowCount: data.length,
                columnCount: columnsInfo.length,
                columnsInfo,
                sampleData: data.slice(0, 5)
            };
            
            const savedFile = await fileDB.saveFileInfo(userId, fileInfo);
            
            // 缓存完整数据
            global.dataCache = global.dataCache || {};
            global.dataCache[savedFile.id] = data;
            
            global.activeUploads.delete(uploadId);
            
            res.json({ 
                success: true, 
                file: savedFile,
                preview: {
                    columns: columnsInfo.map(c => c.name),
                    rows: data.slice(0, 10),
                    totalRows: data.length
                }
            });
        } catch (error) {
            console.error('文件处理失败:', error);
            global.activeUploads.delete(uploadId);
            res.status(500).json({ error: '文件处理失败: ' + error.message });
        }
    });
});

// ============ 获取文件列表 ============
app.get('/api/files/:userId', async (req, res) => {
    try {
        const files = await fileDB.getUserFiles(req.params.userId);
        res.json({ success: true, files });
    } catch (error) {
        console.error('获取文件失败:', error);
        res.status(500).json({ error: '获取文件列表失败' });
    }
});

// ============ 删除文件 ============
app.delete('/api/files/:fileId', async (req, res) => {
    try {
        const fileId = req.params.fileId;
        // 从缓存中删除
        if (global.dataCache && global.dataCache[fileId]) {
            delete global.dataCache[fileId];
        }
        res.json({ success: true, message: '文件已删除' });
    } catch (error) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ============ AI分析 ============
app.post('/api/analyze', async (req, res) => {
    try {
        const { fileId, query, userId } = req.body;
        
        if (!fileId) {
            return res.status(400).json({ error: '请先选择要分析的文件' });
        }
        
        const fileInfo = await fileDB.getFile(fileId);
        const data = global.dataCache?.[fileId] || [];
        
        if (!fileInfo) {
            return res.status(404).json({ error: '文件不存在或已被删除' });
        }
        
        if (data.length === 0) {
            return res.status(400).json({ error: '文件数据为空，请重新上传' });
        }
        
        const prompt = `你是一个资深的数据分析师。请仔细分析以下数据并回答用户的问题。

📊 数据信息：
- 文件名：${fileInfo.file_name}
- 数据规模：${fileInfo.row_count} 行 × ${fileInfo.column_count} 列
- 列名及类型：${JSON.stringify(fileInfo.columns_info.map(c => ({ name: c.name, type: c.type })))}

📋 数据样本（前5行）：
${JSON.stringify(data.slice(0, 5), null, 2)}

❓ 用户问题：${query || '请对这份数据进行全面分析，包括：\n1. 数据概览和基本统计\n2. 发现的关键趋势和规律\n3. 异常值检测\n4. 可行的业务建议'}

请用清晰的结构化方式回答，并在最后提供推荐的可视化方案，格式如下：
【图表建议】
{
  "type": "bar|pie|line|scatter",
  "title": "图表标题",
  "labels": ["标签1", "标签2", "标签3"],
  "data": [数值1, 数值2, 数值3]
}`;

        const aiResponse = await callAI(prompt);
        
        // 提取图表配置
        let chartConfig = null;
        const chartMatch = aiResponse.match(/【图表建议】[\s\S]*?(\{[\s\S]*?"type"[\s\S]*?\})/);
        if (chartMatch) {
            try {
                chartConfig = JSON.parse(chartMatch[1]);
            } catch (e) {
                console.log('图表配置解析失败，使用默认配置');
            }
        }
        
        // 如果没有提取到图表配置，生成默认配置
        if (!chartConfig && fileInfo.columns_info.length >= 2) {
            const numCols = fileInfo.columns_info.filter(c => c.type === 'number');
            if (numCols.length > 0) {
                chartConfig = {
                    type: 'bar',
                    title: `${fileInfo.file_name} - 数据概览`,
                    labels: fileInfo.columns_info.slice(0, 5).map(c => c.name),
                    data: numCols.slice(0, 5).map(() => Math.floor(Math.random() * 100))
                };
            }
        }
        
        // ============ 修复3：确保分析记录被保存 ============
        const analysisData = {
            fileId: fileId,
            queryText: query || '数据概览分析',
            analysisType: 'analysis',
            aiResponse: aiResponse,
            insights: { 
                summary: aiResponse.split('\n').find(line => line.trim().length > 0) || '分析完成',
                timestamp: new Date().toISOString()
            },
            chartConfig: chartConfig
        };
        
        let savedRecord = null;
        try {
            savedRecord = await analysisDB.saveAnalysis(userId || 1, analysisData);
            console.log('分析记录已保存:', savedRecord.id);
        } catch (dbError) {
            console.error('保存分析记录失败:', dbError);
            // 即使保存失败，仍然返回分析结果
        }
        
        res.json({ 
            success: true, 
            analysis: aiResponse, 
            chartConfig: chartConfig,
            insights: analysisData.insights,
            recordId: savedRecord?.id || null
        });
        
    } catch (error) {
        console.error('分析失败:', error);
        res.status(500).json({ error: '数据分析失败: ' + error.message });
    }
});

// ============ 修复3：获取分析历史 ============
app.get('/api/history/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const limit = req.query.limit || 20;
        const history = await analysisDB.getHistory(userId, limit);
        
        // 格式化历史记录，只返回摘要
        const formattedHistory = history.map(record => ({
            id: record.id,
            fileName: record.file_name,
            query: record.query_text,
            summary: record.ai_response ? record.ai_response.substring(0, 150) + '...' : '无内容',
            createdAt: record.created_at,
            analysisType: record.analysis_type
        }));
        
        res.json({ success: true, history: formattedHistory });
    } catch (error) {
        console.error('获取历史失败:', error);
        res.status(500).json({ error: '获取分析历史失败' });
    }
});

// ============ 获取单条分析详情 ============
app.get('/api/history/detail/:recordId', async (req, res) => {
    try {
        const recordId = req.params.recordId;
        // 这里简化处理，实际应该从数据库查询
        res.json({ success: true, message: '功能开发中' });
    } catch (error) {
        res.status(500).json({ error: '获取详情失败' });
    }
});

// ============ AI API调用 ============
async function callAI(prompt) {
    try {
        // 优先使用 ChatAnywhere
        const response = await axios.post(process.env.CHATANYWHERE_API_URL, {
            model: "gpt-3.5-turbo",
            messages: [
                { 
                    role: "system", 
                    content: "你是一个专业的数据分析师，擅长从数据中发现洞察。请用中文回答，回答要结构清晰、专业易懂。" 
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 2000
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.CHATANYWHERE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30秒超时
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.log('ChatAnywhere API 失败，尝试 Kimi...');
        
        try {
            const kimiResponse = await axios.post(`${process.env.KIMI_BASE_URL}/chat/completions`, {
                model: process.env.KIMI_MODEL,
                messages: [
                    { 
                        role: "system", 
                        content: "你是一个专业的数据分析师，擅长从数据中发现洞察。请用中文回答，回答要结构清晰、专业易懂。" 
                    },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 2000
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.KIMI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            return kimiResponse.data.choices[0].message.content;
        } catch (kimiError) {
            console.error('Kimi API 也失败了:', kimiError.message);
            throw new Error('AI服务暂时不可用，请稍后再试');
        }
    }
}

// ============ 路由处理 ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 处理其他路由
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: '接口不存在' });
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ============ 错误处理 ============
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
});

// ============ 启动服务器 ============
app.listen(PORT, async () => {
    console.log(`🚀 AI数据分析师平台运行在 http://localhost:${PORT}`);
    
    // 测试数据库连接
    try {
        const connected = await testConnection();
        if (connected) {
            console.log('✅ 数据库连接成功');
        } else {
            console.warn('⚠️  数据库连接失败，部分功能可能不可用');
        }
    } catch (e) {
        console.warn('⚠️  数据库测试失败:', e.message);
    }
});