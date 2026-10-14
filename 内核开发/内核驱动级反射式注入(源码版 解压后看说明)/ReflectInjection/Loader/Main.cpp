#include "Pch.h"
#include "Injector.h"



int main() {
	printf("输入注入文件路径(可直接拖入):\n");
	const char* windowTitle = "Reflection Injector";

	// 设置窗口名
	SetConsoleTitleA(windowTitle);

	system("color 2");

	HWND hwnd = FindWindowA("UnrealWindow", NULL); // 游戏窗口类名
	DWORD64 pid = 0;
	GetWindowThreadProcessId(hwnd,(DWORD*)&pid);

	printf("PID->%lld\n", pid);


	if (pid)
	{
		Interfaces* Memory = new InterfacesR0;
		Memory->Initialize(pid); //初始化驱动

		//需要注入的dll路径
		if (ManualMapDll(Memory, L"此处填写dll绝对路径")) {
			printf("注入成功\n");
		}
		else {
			printf("Dll 注入失败\n");
		}

		delete Memory;
	}



	system("pause");
	return 0;
}

