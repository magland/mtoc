% Cell array of structs (same struct shape across slots).
s1.x = 1; s1.y = 2;
s2.x = 3; s2.y = 4;
c = {s1, s2};
disp(c{1}.x);
disp(c{1}.y);
disp(c{2}.x);
disp(c{2}.y);
