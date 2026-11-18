import React, { useState } from 'react';
import {
  X,
  Sparkles,
  Send,
  RefreshCw,
  Lightbulb,
  CheckCircle,
  Database,
} from 'lucide-react';
import type { CopilotResponse, CopilotChatContext } from '../types';
import { copilotApi } from '../services/api';

interface AiCopilotModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface MessageItem {
  id: string;
  sender: 'user' | 'copilot';
  text: string;
  data?: CopilotResponse;
  timestamp: string;
}

export const AiCopilotModal: React.FC<AiCopilotModalProps> = ({ isOpen, onClose }) => {
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'welcome',
      sender: 'copilot',
      text: "Hello! I am your AI Delivery Operations Copilot. I can analyze your active campaigns, delivery telemetry, SMTP error codes, sender reputation, and queue bottlenecks using real-time grounded platform data. How can I assist your operations today?",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const [inputQuestion, setInputQuestion] = useState('');
  const [dateRange, setDateRange] = useState<CopilotChatContext['date_range']>('last_7_days');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const quickQuestions = [
    'Which campaign has the highest failure rate?',
    'How is my overall sender reputation and health?',
    'Are there delivery bottlenecks right now?',
    'Do any unknown deliveries require operator review?',
  ];

  const handleSend = async (questionToSend?: string) => {
    const q = (questionToSend || inputQuestion).trim();
    if (!q || loading) return;

    setErrorMessage(null);
    const userMsg: MessageItem = {
      id: `user_${Date.now()}`,
      sender: 'user',
      text: q,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputQuestion('');
    setLoading(true);

    try {
      const res = await copilotApi.chat(q, { date_range: dateRange });
      const copilotMsg: MessageItem = {
        id: `copilot_${Date.now()}`,
        sender: 'copilot',
        text: res.answer,
        data: res,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, copilotMsg]);
    } catch (err: any) {
      const errText = err.message || 'Failed to reach AI Copilot service.';
      setErrorMessage(errText);
      const errorMsg: MessageItem = {
        id: `copilot_err_${Date.now()}`,
        sender: 'copilot',
        text: `Error: ${errText}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-2xl max-w-2xl w-full h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/80 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-700 text-white shadow-xs">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm sm:text-base text-slate-900">AI Delivery Copilot</h3>
                <span className="text-[10px] uppercase font-extrabold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                  Grounded Ops
                </span>
              </div>
              <p className="text-[11px] text-slate-500">Autonomous email operations and telemetry intelligence</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Context Date Range Switcher */}
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as any)}
              className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 shadow-xs"
            >
              <option value="last_24_hours">Last 24 Hours</option>
              <option value="last_7_days">Last 7 Days</option>
              <option value="last_30_days">Last 30 Days</option>
              <option value="all_time">All Time</option>
            </select>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Chat History Messages */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {errorMessage && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs">
              ⚠️ {errorMessage}
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div className="flex items-center gap-1.5 mb-1 px-1">
                {m.sender === 'copilot' ? (
                  <>
                    <Sparkles className="w-3 h-3 text-indigo-600" />
                    <span className="text-[11px] font-bold text-slate-700">Copilot</span>
                  </>
                ) : (
                  <span className="text-[11px] font-bold text-slate-700">You</span>
                )}
                <span className="text-[10px] text-slate-400">{m.timestamp}</span>
              </div>

              <div
                className={`p-3.5 rounded-2xl max-w-xl text-xs sm:text-[13px] leading-relaxed shadow-xs ${
                  m.sender === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-xs'
                    : 'bg-slate-50 border border-slate-200 text-slate-800 rounded-bl-xs space-y-3'
                }`}
              >
                <p className="whitespace-pre-wrap">{m.text}</p>

                {/* Structured Insights & Recommendations if present */}
                {m.data && (
                  <div className="pt-2 border-t border-slate-200/80 space-y-2.5">
                    {/* Insights */}
                    {m.data.insights && m.data.insights.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-900 flex items-center gap-1">
                          <Lightbulb className="w-3 h-3 text-indigo-600" />
                          <span>Observed Insights</span>
                        </span>
                        <ul className="space-y-1">
                          {m.data.insights.map((ins, i) => (
                            <li key={i} className="text-[11px] text-slate-600 bg-white p-1.5 rounded-lg border border-slate-100">
                              • {ins}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Recommendations */}
                    {m.data.recommendations && m.data.recommendations.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-900 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3 text-emerald-600" />
                          <span>Recommended Actions</span>
                        </span>
                        <ul className="space-y-1">
                          {m.data.recommendations.map((rec, i) => (
                            <li key={i} className="text-[11px] text-emerald-900 bg-emerald-50/60 p-1.5 rounded-lg border border-emerald-100">
                              → {rec}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Grounded Sources */}
                    {m.data.sources && m.data.sources.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap pt-1 text-[10px] text-slate-400">
                        <Database className="w-3 h-3" />
                        <span>Sources:</span>
                        {m.data.sources.map((s, i) => (
                          <span
                            key={i}
                            className="px-1.5 py-0.5 rounded bg-slate-200/80 text-slate-700 font-mono text-[9px]"
                          >
                            {s.type}:{s.label || s.id?.slice(0, 8) || 'telemetry'}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 p-3 text-xs text-slate-500 bg-slate-50 rounded-xl border border-slate-200 w-fit">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" />
              <span>Grounded Copilot is analyzing campaign telemetry & queues...</span>
            </div>
          )}
        </div>

        {/* Quick Question Chips */}
        <div className="px-5 py-2 bg-slate-50/60 border-t border-slate-100 flex items-center gap-1.5 overflow-x-auto shrink-0">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider shrink-0">
            Suggested:
          </span>
          {quickQuestions.map((q, i) => (
            <button
              key={i}
              type="button"
              disabled={loading}
              onClick={() => handleSend(q)}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white hover:bg-indigo-50 hover:text-indigo-600 border border-slate-200 hover:border-indigo-200 text-slate-600 whitespace-nowrap transition-colors disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-slate-100 bg-white shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              placeholder="Ask an operational question (e.g. failure causes, sender health, queue bottlenecks)..."
              value={inputQuestion}
              onChange={(e) => setInputQuestion(e.target.value)}
              disabled={loading}
              className="flex-1 text-xs bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:bg-white transition-colors"
            />
            <button
              type="submit"
              disabled={!inputQuestion.trim() || loading}
              className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors disabled:opacity-40"
              title="Send question"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
