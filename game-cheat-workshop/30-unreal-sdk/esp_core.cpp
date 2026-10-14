// Unreal ESP 核心逻辑 (SDK dump 完成后用)
// 配合 40-dx11-overlay 里的 ImGui 画框

#include "SDK.hpp"      // 从 Dumper-7 产出
#include <imgui.h>
#include <cmath>

using namespace SDK;

struct Target {
    FVector2D screen;
    float distance;
    float hp;
    float max_hp;
    bool  visible;
};

static bool WorldToScreen(const FVector& world, const FMinimalViewInfo& view,
                          FVector2D screen_size, FVector2D& out) {
    FVector dir = world - view.Location;
    FRotator rot = view.Rotation;

    const float cp = cosf(rot.Pitch * (float)M_PI / 180.f);
    const float sp = sinf(rot.Pitch * (float)M_PI / 180.f);
    const float cy = cosf(rot.Yaw   * (float)M_PI / 180.f);
    const float sy = sinf(rot.Yaw   * (float)M_PI / 180.f);
    const float cr = cosf(rot.Roll  * (float)M_PI / 180.f);
    const float sr = sinf(rot.Roll  * (float)M_PI / 180.f);

    // 简化版 (不处理 roll). 实战里推荐直接调 UGameplayStatics::ProjectWorldToScreen,
    // 或者用完整的 FRotationMatrix::GetUnitAxis(EAxis::X/Y/Z).
    (void)cr; (void)sr;
    FVector forward{cp*cy, cp*sy, sp};
    FVector right  {-sy, cy, 0};
    FVector up     {-sp*cy, -sp*sy, cp};

    float x = FVector::DotProduct(dir, right);
    float y = FVector::DotProduct(dir, up);
    float z = FVector::DotProduct(dir, forward);
    if (z < 1.f) return false;

    float fov = view.FOV * 0.5f;
    float screen_center_x = screen_size.X * 0.5f;
    float screen_center_y = screen_size.Y * 0.5f;
    out.X = screen_center_x + x * (screen_center_x / tanf(fov * (float)M_PI / 180.f)) / z;
    out.Y = screen_center_y - y * (screen_center_x / tanf(fov * (float)M_PI / 180.f)) / z;
    return true;
}

void DrawESP(ImDrawList* dl, FVector2D screen) {
    UWorld* world = UWorld::GetWorld();
    if (!world) return;
    AGameStateBase* gs = world->GameState;
    if (!gs) return;

    APlayerController* pc = world->OwningGameInstance->LocalPlayers[0]->PlayerController;
    APawn* me = pc ? pc->K2_GetPawn() : nullptr;
    FMinimalViewInfo view{};
    pc->PlayerCameraManager->GetCameraViewPoint(&view.Location, &view.Rotation);
    view.FOV = pc->PlayerCameraManager->GetFOVAngle();

    for (int i = 0; i < gs->PlayerArray.Num(); ++i) {
        APlayerState* ps = gs->PlayerArray[i];
        APawn* pawn = ps ? ps->PawnPrivate : nullptr;
        if (!pawn || pawn == me) continue;

        FVector head = pawn->K2_GetActorLocation() + FVector{0, 0, 90.f};
        FVector feet = pawn->K2_GetActorLocation() + FVector{0, 0, -90.f};

        FVector2D s_head, s_feet;
        if (!WorldToScreen(head, view, screen, s_head)) continue;
        if (!WorldToScreen(feet, view, screen, s_feet)) continue;

        float h = fabsf(s_feet.Y - s_head.Y);
        float w = h * 0.5f;
        ImVec2 tl{s_head.X - w*0.5f, s_head.Y};
        ImVec2 br{s_head.X + w*0.5f, s_feet.Y};
        dl->AddRect(tl, br, IM_COL32(255, 0, 0, 255), 0.f, 0, 2.f);

        // 血条
        float hp_ratio = 0.5f; // pawn->GetHealth() / pawn->GetMaxHealth();
        ImVec2 hb_tl{tl.x - 6, tl.y};
        ImVec2 hb_br{tl.x - 2, br.y};
        dl->AddRectFilled(hb_tl, hb_br, IM_COL32(50, 50, 50, 200));
        ImVec2 hp_br{hb_br.x, hb_br.y - (hb_br.y - hb_tl.y)*(1.f-hp_ratio)};
        dl->AddRectFilled(hb_tl, hp_br, IM_COL32(0, 255, 0, 255));
    }
}
