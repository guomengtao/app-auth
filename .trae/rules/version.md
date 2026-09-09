---
alwaysApply: true
---


每次发布新版本时，都需要更新版本号
每次改动后都push代码到远程仓库
md文档内容中文书写，避免使用英文

 每次对话开始和结束需要我确认的操作或者执行完成对话之前,必须在命令行执行: res=$(osascript -e 'display dialog "是否重试下载AstroBox插件？" buttons {"取消","重试"} default button "重试" with icon caution')
if [[ $res == *"重试"* ]]; then
  echo "用户选择重试"
else
  echo "用户取消"
fi
类似这个提示.方便我及时收到弹窗通知.协助你操纵.